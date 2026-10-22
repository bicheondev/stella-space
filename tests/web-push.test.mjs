import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerWebPush,openWebPush} from '../scripts/web-push.mjs';
test('Web Push registers only at X with public encryption key and suppresses raw rejection bodies',async()=>{
 const options={headersFor:async()=>({'content-type':'application/json'}),fetcher:async(url,request)=>{assert.equal(url,'https://x.com/i/api/1.1/notifications/settings/login.json');const d=JSON.parse(request.body).push_device_info;assert.equal(d.token,'https://updates.push.services.mozilla.com/test');assert.equal(d.encryption_key1,'public-key');return Response.json({success:true})}};
 const state={endpoint:'https://updates.push.services.mozilla.com/test'},decryptor={getPublicKeyBase64url:()=> 'public-key',getAuthBase64url:()=> 'auth-secret'};
 await registerWebPush({},state,decryptor,options);
 await assert.rejects(()=>registerWebPush({},state,decryptor,{...options,fetcher:async()=>new Response('secret-cookie',{status:403})}),e=>e.message==='X 푸시 기기 등록 실패 (403)');
 await assert.rejects(()=>registerWebPush({},state,decryptor,{...options,fetcher:async()=>Response.json({errors:[{message:'secret-cookie'}]})}),e=>!e.message.includes('secret-cookie'));
});

test('receiver restores a subscription without registering again and saves only after successful registration',async()=>{
 let closed=0,saved=0,registered=0;
 class Client{constructor(options){this.options=options}async connect(){return 'https://updates.push.services.mozilla.com/wpush/v2/test'}getUaid(){return 'uaid'}getRemoteBroadcasts(){return{}}close(){closed++}}
 const decryptor={getJwk:()=>({d:'private'}),getAuthBase64url:()=> 'auth'};
 const options={Client,createDecryptor:async()=>decryptor,signal:new AbortController().signal,session:{},onNotification:async()=>{},onDisconnected:()=>{},saveState:async()=>{saved++},register:async()=>{registered++}};
 const first=await openWebPush(options);assert.equal(registered,1);assert.equal(saved,1);first.close();assert.equal(closed,1);
 const second=await openWebPush({...options,state:{endpoint:'https://updates.push.services.mozilla.com/wpush/v2/test',channelId:'existing'}});assert.equal(registered,1);second.close();
 await assert.rejects(()=>openWebPush({...options,register:async()=>{throw Error('registration rejected')}}));assert.equal(saved,2);assert.equal(closed,3);
});
