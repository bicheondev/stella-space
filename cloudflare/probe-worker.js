import {DurableObject} from 'cloudflare:workers';
import {createRequestBudget} from './request-budget.js';

// Isolated runtime probe. It never imports production collection, credentials,
// databases, or notification code, and never accepts an upstream URL from input.
export const PROBE_TARGET='https://example.com/';
const SOAK_MS=20*60*1000,SOAK_FETCH_MS=30000,SOAK_ALARM_MS=10000;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const authorized=(request,env)=>typeof env.PROBE_SECRET==='string'&&env.PROBE_SECRET.length>=16&&request.headers.get('Authorization')==='Bearer '+env.PROBE_SECRET;
export default{async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(!['/start','/status','/stop'].includes(path))return json({error:'Not found'},404);
 if(!authorized(request,env))return json({error:'Unauthorized'},401);
 if(request.method!==(path==='/status'?'GET':'POST'))return json({error:'Method not allowed'},405);
 return env.PROBE.getByName('free-runtime-probe').fetch(request);
}};

function sleep(ms,signal){return new Promise((resolve,reject)=>{const cleanup=()=>signal.removeEventListener('abort',abort),timer=setTimeout(()=>{cleanup();resolve();},ms),abort=()=>{clearTimeout(timer);cleanup();reject(signal.reason||Error('Stopped'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});}
export class FreeTierProbe extends DurableObject{
 constructor(ctx,env){
  super(ctx,env);this.ctx=ctx;this.env=env;this.state=null;this.budget=null;this.controller=null;this.task=null;
  this.ready=ctx.blockConcurrencyWhile(async()=>{
   this.state=await ctx.storage.get('result')||null;
   if(this.state?.status==='running'){
    // A restart changes the event budget. Do not quietly resume and claim the
    // original invocation survived; report the interruption for this probe.
    this.state.status='interrupted';this.state.error='Durable Object restarted during the probe';this.state.finishedAt=Date.now();this.state.elapsedMs=this.state.finishedAt-this.state.startedAt;
    await ctx.storage.put('result',this.state);await ctx.storage.deleteAlarm();
   }
  });
 }
 async fetch(request){
  await this.ready;
  if(!authorized(request,this.env))return json({error:'Unauthorized'},401);
  const path=new URL(request.url).pathname;
  if(this.state?.status==='running'){
   this.state.incomingDuringRun++;this.state.contaminated=true;
   await this.save();
  }
  if(path==='/status')return json(this.snapshot(),this.state?.status==='running'?409:200);
  if(path==='/stop'){await this.stop();return json(this.snapshot());}
  if(path!=='/start')return json({error:'Not found'},404);
  if(this.state?.status==='running')return json({error:'Probe already running; stop it before restarting'},409);
  let body;try{const raw=await request.text();if(raw.length>1024)throw Error();body=JSON.parse(raw);}catch{return json({error:'Expected a small JSON body'},400);}
  if(!['negative','positive','soak'].includes(body?.mode))return json({error:'mode must be negative, positive, or soak'},400);
  await this.start(body.mode);
  return json({runId:this.state.runId,mode:this.state.mode,status:'running',targetRequests:this.state.targetRequests,readStatusAfter:body.mode==='soak'?this.state.startedAt+SOAK_MS+15000:null,note:'Do not request status while running: incoming requests can replenish the execution budget and invalidate the probe.'},202);
 }
 snapshot(){return this.state?{...this.state,...(this.state.status==='running'?{elapsedMs:Date.now()-this.state.startedAt}:{}),budget:this.budget?.stats()||this.state.budget||null}:{status:'idle'};}
 async save(){if(this.state)await this.ctx.storage.put('result',{...this.state,budget:this.budget?.stats()||this.state.budget||null});}
 async start(mode){
  this.controller=new AbortController();this.state={runId:crypto.randomUUID(),mode,status:'running',startedAt:Date.now(),finishedAt:null,elapsedMs:0,targetRequests:mode==='negative'?51:mode==='positive'?160:null,attempted:0,completed:0,bytes:0,httpStatuses:{},alarms:0,alarmsRequested:0,ticks:0,incomingDuringRun:0,contaminated:false,error:null};
  this.budget=mode==='negative'?null:createRequestBudget({fetcher:fetch,onExhausted:async()=>{if(this.state.status!=='running')return;this.state.alarmsRequested++;await this.save();if(this.state.status==='running')await this.ctx.storage.setAlarm(Date.now()+1000);}});
  await this.save();
  if(mode==='soak'){this.state.alarmsRequested++;await this.ctx.storage.setAlarm(Date.now()+SOAK_ALARM_MS);}
  this.task=this.run();this.ctx.waitUntil(this.task);
 }
 async request(){
  this.state.attempted++;
  const response=await (this.budget?.fetch||fetch)(PROBE_TARGET,{redirect:'manual',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)]),headers:{'Cache-Control':'no-cache'}});
  const bytes=await response.arrayBuffer();this.state.bytes+=bytes.byteLength;this.state.completed++;this.state.httpStatuses[response.status]=(this.state.httpStatuses[response.status]||0)+1;
 }
 async run(){
  try{
   if(this.state.mode==='soak'){
    let nextFetch=this.state.startedAt;
    while(!this.controller.signal.aborted&&Date.now()-this.state.startedAt<SOAK_MS){
     this.state.ticks++;
     if(Date.now()>=nextFetch){await this.request();nextFetch=Date.now()+SOAK_FETCH_MS;}
     await sleep(1000,this.controller.signal);
    }
   }else for(let i=0;i<this.state.targetRequests;i++)await this.request();
   if(this.state.status==='running')this.state.status='completed';
  }catch(error){if(this.state.status==='running'){this.state.status='failed';this.state.error=String(error?.message||error).slice(0,300);}}
  finally{
   this.state.finishedAt=Date.now();this.state.elapsedMs=this.state.finishedAt-this.state.startedAt;
   await this.save();await this.ctx.storage.deleteAlarm();
   console.log(JSON.stringify({kind:'free-runtime-probe-finished',...this.snapshot()}));
  }
 }
 async alarm(){
  await this.ready;if(this.state?.status!=='running')return;
  this.state.alarms++;this.budget?.reset();await this.save();
  if(this.state.status==='running'&&this.state.mode==='soak'){this.state.alarmsRequested++;await this.ctx.storage.setAlarm(Date.now()+SOAK_ALARM_MS);}
  if(this.task)this.ctx.waitUntil(this.task);
 }
 async stop(){
  if(this.state?.status==='running')this.state.status='stopped';
  this.controller?.abort();this.budget?.close();if(this.task)await this.task;
  await this.ctx.storage.deleteAlarm();await this.save();
 }
}
