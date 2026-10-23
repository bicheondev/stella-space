import {createEventLog} from './event-log.js';
import {DurableObject} from 'cloudflare:workers';
import {createDatabase} from './database.js';
import {createCollector} from './collector.js';
import {createNotificationReceiver} from './notifications.js';
import {createHub} from './hub.js';
import {createRequestBudget} from './request-budget.js';
import {broadcastWebhook} from '../server/broadcast-webhook.js';

const PUBLIC_ROUTES = new Set(['/api/members','/api/member','/api/resolve','/api/replies','/api/chat-history','/api/live','/health']);
const CONTROL_ROUTES = new Set(['/control/status','/control/events','/control/start','/control/stop','/control/retire-previous']);
const WATCHDOG_MS = 30000;
const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const count = value => { const number = Number(value || 0); if (!Number.isSafeInteger(number) || number < 0) throw Error('Invalid cursor'); return number; };
function publicOrigin(env) { return env.PUBLIC_ORIGIN || 'https://spacelive.vercel.app'; }
async function authorized(request, env) {
  const secret = env.COLLECTOR_SECRET?.trim();
  if (!secret) return false;
  const actual = new TextEncoder().encode(request.headers.get('authorization') || '');
  const expected = new TextEncoder().encode('Bearer ' + secret);
  if (actual.length !== expected.length) return false;
  const key = await crypto.subtle.importKey('raw', expected, {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
  return crypto.subtle.verify('HMAC', key, await crypto.subtle.sign('HMAC', key, expected), actual);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('origin');
    const isControl = CONTROL_ROUTES.has(url.pathname);
    if (!PUBLIC_ROUTES.has(url.pathname) && !isControl) return json({error:'Not found'},404);
    if (isControl && !await authorized(request,env)) return json({error:'Unauthorized'},401);
    if (isControl && request.method !== (['/control/status','/control/events'].includes(url.pathname) ? 'GET' : 'POST')) return json({error:'Method not allowed'},405);
    if (!isControl && origin && origin !== publicOrigin(env)) return json({error:'Origin not allowed'},403);
    if (!isControl && request.method === 'OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':publicOrigin(env),'Access-Control-Allow-Methods':'GET','Access-Control-Max-Age':'86400','Vary':'Origin'}});
    if (!isControl && request.method !== 'GET') return json({error:'Method not allowed'},405);
    if (url.pathname === '/api/live' && (origin !== publicOrigin(env) || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')) return json({error:'WebSocket required'},400);
    if (url.pathname === '/control/retire-previous') {
      const results=[];
      for(const name of ['spacelive','spacelive-v2']) {const response=await env.COORDINATOR.getByName(name).fetch(new Request('https://coordinator/control/stop',{method:'POST'}));results.push({name,status:response.status,...await response.json()});}
      return json(results);
    }
    // All viewers and all members share this one object; additional objects would spend another duration allocation.
    const result = await env.COORDINATOR.getByName(env.COORDINATOR_NAME || 'spacelive').fetch(request);
    if (result.status === 101) return result;
    const response = new Response(result.body,result);
    if (!isControl) { response.headers.set('Access-Control-Allow-Origin', publicOrigin(env)); response.headers.set('Vary','Origin'); }
    return response;
  },
};

export class SpaceliveCoordinator extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.ctx=ctx; this.env=env; this.enabled=false; this.ready=false; this.boot=null;
    this.timer=null; this.receiverDue=0; this.receiverPending=null; this.retryWebhookAt=0; this.webhookPending=null;
    this.nextAlarmAt=0;this.alarmWrite=null;
    this.lifetime=null; this.collector=null; this.receiver=null; this.db=null; this.lastError=null;
    this.events=createEventLog(ctx.storage);this.events.record('coordinator.boot');
    this.errors=new Map(); this.startedAt=Date.now(); this.metrics={http:0,connections:0,alarms:0,upstream:0,upstreamErrors:0,newMessages:0};
    this.hub=createHub({sockets:()=>this.ctx.getWebSockets(),readRoom:(id,options)=>this.collector.room(id,options),waitUntil:task=>this.ctx.waitUntil(task)});
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
    this.ctx.blockConcurrencyWhile(async()=>{this.enabled=!!await this.ctx.storage.get('enabled');this.nextAlarmAt=await this.ctx.storage.getAlarm() || 0;});
  }
  async initialize() {
    if (this.ready) return;
    this.boot ||= (async()=>{
      this.lifetime=new AbortController();
      this.budget=createRequestBudget({onExhausted:()=>this.replenishSoon(),fetcher:async(...args)=>{this.metrics.upstream++;try{return await fetch(...args);}catch(error){this.metrics.upstreamErrors++;throw error;}}});
      const fetcher=this.fetcher=this.budget.fetch;
      this.db?.close();this.db=createDatabase(this.env,{fetcher});
      this.collector=createCollector({db:this.db,fetcher,
        onMembers:members=>this.hub.broadcastMembers(members),
        onMessages:data=>{this.metrics.newMessages+=data.messages.length;this.hub.publishRoom(data.postId);},
        onEvent:(kind,data)=>this.events.record(kind,data),
        onError:error=>this.recordError(error),
        onBroadcast:({previous,current,name})=>broadcastWebhook(this.db,previous,current,name,{fetcher}),
        notificationHealth:()=>this.receiver?.status() || {},
      });
      await this.collector.initialize();
      this.receiver=createNotificationReceiver({onEvent:(kind,data)=>this.events.record(kind,data),db:this.db,signal:this.lifetime.signal,fetcher,beforeConnect:({signal})=>this.budget.reserve(signal),waitUntil:task=>this.ctx.waitUntil(task),onPosts:async posts=>{await this.collector.ingestPosts(posts);if(this.enabled)this.kick();}});
      this.ready=true;
    })().catch(error=>{this.boot=null;this.lastError='Initialization failed';throw error;});
    return this.boot;
  }
  async scheduleAlarm(delay) {
    if(this.alarmWrite)await this.alarmWrite;
    const due=Date.now()+delay;
    if(this.nextAlarmAt>Date.now() && this.nextAlarmAt<=due)return;
    this.nextAlarmAt=due;
    this.alarmWrite=this.ctx.storage.setAlarm(due).finally(()=>{this.alarmWrite=null;});
    return this.alarmWrite;
  }
  replenishSoon() {
    // During a busy broadcast alarms already run every two seconds. Reusing the
    // scheduled alarm avoids doubling SQLite writes for each budget refill.
    if(this.nextAlarmAt>Date.now() && this.nextAlarmAt<=Date.now()+2000)return;
    return this.scheduleAlarm(50);
  }
  async recordError({key,error,at}) {
    this.lastError=String(error).slice(0,500);
    // Keep repeated provider failures from becoming a write loop.
    if ((this.errors.get(key)||0)>Date.now()-60000) return;
    this.errors.set(key,Date.now());this.events.record('collector.error',{key});
    await this.db.prepare('INSERT INTO collector_errors(at,key,error) VALUES(?1,?2,?3)').bind(at || Date.now(),key,this.lastError).first();
  }
  kick() {
    if (!this.enabled || !this.ready || this.timer) return;
    const delay=this.collector.step();
    if (!this.receiverPending && Date.now()>=this.receiverDue) {
      this.receiverDue=Date.now()+1000;
      this.receiverPending=this.receiver.step().catch(error=>this.recordError({key:'cloudflare:push',error:error.message})).finally(()=>{this.receiverPending=null;});
      this.ctx.waitUntil(this.receiverPending);
    }
    if (!this.webhookPending && Date.now()>=this.retryWebhookAt) {
      this.retryWebhookAt=Date.now()+60000;
      this.webhookPending=broadcastWebhook(this.db,null,{},'',{fetcher:this.fetcher}).catch(error=>this.recordError({key:'cloudflare:webhook',error:error.message})).finally(()=>{this.webhookPending=null;});
      this.ctx.waitUntil(this.webhookPending);
    }
    this.timer=setTimeout(()=>{this.timer=null;this.kick();},Math.max(100,delay));
  }
  async start() {
    await this.initialize();
    this.enabled=true;this.events.record('coordinator.start');
    await this.ctx.storage.put('enabled',true);
    await this.scheduleAlarm(WATCHDOG_MS);
    this.kick();
  }
  async stop() {
    this.events.record('coordinator.stop');this.events.flush();
    this.enabled=false; clearTimeout(this.timer);this.timer=null;
    await this.ctx.storage.put('enabled',false);
    if(this.alarmWrite)await this.alarmWrite;
    await this.ctx.storage.deleteAlarm();this.nextAlarmAt=0;
    this.collector?.stop();this.lifetime?.abort();
    this.budget?.reset();
    await Promise.allSettled([this.receiver?.stop(),this.collector?.settled(),this.receiverPending,this.webhookPending]);
    this.budget?.close();this.ready=false;this.boot=null;this.receiver=null;this.collector=null;
    // Existing sockets reconnect and receive an authoritative snapshot after a later start.
    for (const socket of this.ctx.getWebSockets()) try{socket.close(1012,'Collector paused');}catch{}
  }
  async alarm() {
    this.metrics.alarms++;this.events.flush();
    const previousBudget=this.budget?.stats();
    this.nextAlarmAt=0;
    if(this.enabled)await this.scheduleAlarm(previousBudget?.used>=24 || previousBudget?.queued?2000:WATCHDOG_MS);
    this.budget?.reset();
    if (!this.enabled) return;
    try{await this.initialize();this.kick();}catch(error){console.error('Coordinator recovery failed:',error.message);}
  }
  async fetch(request) {
    this.metrics.http++;
    const url=new URL(request.url);
    try {
      if (url.pathname==='/control/start') {await this.start();return json(this.status());}
      if (url.pathname==='/control/stop') {await this.stop();return json(this.status());}
      if (url.pathname==='/control/events') return json(this.events.read(count(url.searchParams.get('after'))));
      if (url.pathname==='/control/status') return json(this.status(true));
      if (url.pathname==='/health') return json({ready:this.ready,collecting:this.enabled});
      await this.initialize();
      // Public traffic only reads; alarms and the private start control own scheduling.
      if (url.pathname==='/api/live') {
        if(this.ctx.getWebSockets().length>=2000) return json({error:'Connection limit'},503);
        const pair=new WebSocketPair(), client=pair[0],server=pair[1];
        this.ctx.acceptWebSocket(server);this.metrics.connections++;
        this.hub.accept(server);
        server.send(JSON.stringify({type:'members',members:this.collector.snapshot()}));
        return new Response(null,{status:101,webSocket:client});
      }
      if (url.pathname==='/api/members') return json(this.collector.snapshot());
      if (url.pathname==='/api/member') {
        const handle=url.searchParams.get('handle') || '';
        const member=this.collector.snapshot().find(value=>value.handle.toLowerCase()===handle.toLowerCase());
        return member?json(member):json({error:'Unknown member'},404);
      }
      if (url.pathname==='/api/resolve') return json(await this.collector.resolve(url.searchParams.get('url')));
      const id=url.searchParams.get('id');
      if(!/^\d{2,20}$/.test(id || ''))return json({error:'Invalid room'},400);
      if(url.pathname==='/api/chat-history') {
        const before=count(url.searchParams.get('before'));if(!before)return json({error:'Invalid cursor'},400);
        return json(await this.collector.room(id,{before}));
      }
      if(url.pathname==='/api/replies')return json(await this.collector.room(id,{after:count(url.searchParams.get('after')),latest:url.searchParams.get('latest')==='1'}));
      return json({error:'Not found'},404);
    }catch(error){console.error('Coordinator request failed:',error.message);return json({error:'요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503);}
  }
  status(privateView=false) {
    return {revision:'provider-recovery-20261023',ready:this.ready,enabled:this.enabled,startedAt:this.startedAt,connections:this.ctx.getWebSockets().length,...(privateView?{metrics:this.metrics,budget:this.budget?.stats(),notification:this.receiver?.status() || null,lastError:this.lastError,members:this.collector?.snapshot() || []}:{})};
  }
  async webSocketMessage(socket,message) {await this.initialize();return this.hub.handle(socket,message);}
  webSocketClose(socket) {this.hub.remove(socket);}
  webSocketError(socket) {this.hub.remove(socket);try{socket.close(1011,'Connection error');}catch{}}
}
