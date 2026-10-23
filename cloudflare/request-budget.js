// A Durable Object has one shared I/O context. An alarm replenishes its invocation
// budget; timers alone do not. Count Turso HTTP and provider HTTP in the same pool.
export function createRequestBudget({fetcher=fetch,onExhausted,limit=36,concurrency=4,maxBytes=8*1024*1024}={}) {
  let used=0,active=0,requested=false,closed=false;
  const queue=[];
  function drain() {
    while(!closed&&queue.length&&active<concurrency&&used<limit){
      const task=queue.shift();task.signal?.removeEventListener('abort',task.abort);
      if(task.signal?.aborted){task.reject(task.signal.reason);continue;}
      active++;used++;task.resolve();
    }
    if(!closed&&queue.length&&used>=limit&&!requested){
      requested=true;
      Promise.resolve().then(onExhausted).catch(error=>{requested=false;while(queue.length)queue.shift().reject(error);});
    }
  }
  function acquire(signal) {
    if(closed)return Promise.reject(Error('Collector stopped'));
    if(signal?.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const task={resolve,reject,signal,abort:()=>{const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);reject(signal.reason);}};
      signal?.addEventListener('abort',task.abort,{once:true});queue.push(task);drain();
    });
  }
  async function budgetFetch(input,init={}) {
    const signal=init.signal || input?.signal;
    await acquire(signal);
    try{
      const rejectRedirect=init.redirect==='error';
      const response=await fetcher(input,{...init,redirect:rejectRedirect?'manual':init.redirect||'manual'});
      if(rejectRedirect&&[301,302,303,307,308].includes(response.status)){await response.body?.cancel();throw new TypeError('Upstream redirect rejected');}
      if(!response.body)return response;
      // Release the connection slot after the body has actually drained. Otherwise
      // metadata bursts can exhaust Workers' six simultaneous outgoing connections.
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('Upstream response too large');chunks.push(value);}
      }catch(error){await reader.cancel().catch(()=>{});throw error;}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    }finally{active--;drain();}
  }
  return {fetch:budgetFetch,async reserve(signal){await acquire(signal);active--;drain();},reset(){used=0;requested=false;drain();},stats:()=>({used,active,queued:queue.length,limit}),close(){closed=true;while(queue.length){const task=queue.shift();task.signal?.removeEventListener('abort',task.abort);task.reject(Error('Collector stopped'));}}};
}
