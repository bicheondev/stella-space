import {AutopushClient} from 'xnotif';

// xnotif 0.2.1 does not send the Autopush application's {} keepalive.
// This narrow adapter retains its handshake, subscription, ack and decryption
// behavior. The locked dependency exposes `ws` as a runtime property; regression
// tests exercise this adapter against the real installed client, not a stand-in.
// Autopush clients must not send application pings more than once per minute.
export const PUSH_KEEPALIVE_MS=65000;
export class LeasedAutopushClient extends AutopushClient {
 constructor(options,{now=Date.now,setInterval:repeat=globalThis.setInterval,clearInterval:cancel=globalThis.clearInterval}={}){
  super(options);this.clock=now;this.repeat=repeat;this.cancel=cancel;this.keepalive=null;this.openedAt=null;this.closeInfo=null;
 }
 reconnect(){} // Ownership and backoff belong to the receiver, never the library.
 stopKeepalive(){if(this.keepalive!==null){this.cancel(this.keepalive);this.keepalive=null;}}
 diagnostics(){return this.closeInfo||{durationMs:this.openedAt===null?0:Math.max(0,this.clock()-this.openedAt)};}
 async connect(){
  const pending=super.connect(),socket=this.ws;
  if(!socket)return pending;
  this.openedAt=this.clock();
  const onClose=socket.onclose;
  socket.onclose=event=>{
   this.stopKeepalive();
   // Close reasons can contain upstream data; retain numeric/boolean metadata only.
   this.closeInfo={code:Number.isInteger(event.code)?event.code:0,wasClean:event.wasClean===true,durationMs:Math.max(0,this.clock()-this.openedAt)};
   onClose?.call(socket,event);
  };
  try{
   const endpoint=await pending;
   if(this.closed||socket.readyState!==1)throw Error('푸시 연결이 준비 중 종료되었습니다.');
   this.keepalive=this.repeat(()=>{
    if(this.closed||socket.readyState!==1){this.stopKeepalive();return;}
    try{socket.send('{}');}catch{this.stopKeepalive();try{socket.close();}catch{}}
   },PUSH_KEEPALIVE_MS);
   this.keepalive?.unref?.();
   return endpoint;
  }catch(error){this.stopKeepalive();throw error;}
 }
 close(){this.stopKeepalive();super.close();}
}
