import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerWebPush} from '../scripts/web-push.mjs';
test('Web Push registers only at X with public encryption key and suppresses raw rejection bodies',async()=>{
 const options={headersFor:async()=>({'content-type':'application/json'}),fetcher:async(url,request)=>{assert.equal(url,'https://x.com/i/api/1.1/notifications/settings/login.json');const d=JSON.parse(request.body).push_device_info;assert.equal(d.token,'https://updates.push.services.mozilla.com/test');assert.equal(d.encryption_key1,'public-key');return Response.json({success:true})}};
 const state={endpoint:'https://updates.push.services.mozilla.com/test'},decryptor={getPublicKeyBase64url:()=> 'public-key',getAuthBase64url:()=> 'auth-secret'};
 await registerWebPush({},state,decryptor,options);
 await assert.rejects(()=>registerWebPush({},state,decryptor,{...options,fetcher:async()=>new Response('secret-cookie',{status:403})}),e=>e.message==='X 푸시 기기 등록 실패 (403)');
 await assert.rejects(()=>registerWebPush({},state,decryptor,{...options,fetcher:async()=>Response.json({errors:[{message:'secret-cookie'}]})}),e=>!e.message.includes('secret-cookie'));
});
