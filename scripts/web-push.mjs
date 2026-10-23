import {AutopushClient,Decryptor} from 'xnotif';
import {randomUUID} from 'node:crypto';
import {signedXHeaders} from '../server/x-notifications.js';
// Reconnect only after renewing our server lease; the upstream auto-retry can outlive ownership.
class LeasedAutopushClient extends AutopushClient{reconnect(){}}
export const X_VAPID='BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs';
export async function registerWebPush(session,state,decryptor,{fetcher=fetch,headersFor=signedXHeaders,signal}={}){
 const path='/1.1/notifications/settings/login.json';
 const response=await fetcher('https://x.com/i/api'+path,{method:'POST',headers:await headersFor(session,'POST',path),body:JSON.stringify({push_device_info:{os_version:'Web/Chrome',udid:'Web/Chrome',env:3,locale:'en',protocol_version:1,token:state.endpoint,encryption_key1:decryptor.getPublicKeyBase64url(),encryption_key2:decryptor.getAuthBase64url()}}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('X 푸시 기기 등록 실패 ('+response.status+')');
 const result=await response.json();if(result.errors?.length)throw Error('X가 푸시 기기 등록을 거절했습니다.');
}
// Explicit lifecycle: close before retry, so the library cannot reclaim a handed-off connection.
export async function openWebPush({session,state,signal,onNotification,onDisconnected,saveState,Client=LeasedAutopushClient,createDecryptor=(...args)=>Decryptor.create(...args),register=registerWebPush,fetcher=fetch,headersFor=signedXHeaders,beforeConnect=async()=>{}}){
 const decryptor=await createDecryptor(state?.decryptor?.jwk,state?.decryptor?.auth);
 const channelId=state?.channelId||randomUUID();
 let client;const close=()=>client?.close();
 client=new Client({uaid:state?.uaid,channelId,vapidKey:X_VAPID,remoteBroadcasts:state?.remoteBroadcasts,
 onNotification:async n=>{try{await decryptor.decrypt(n.headers.crypto_key,n.headers.encryption,Uint8Array.from(Buffer.from(n.data,'base64url')).buffer);await onNotification();}catch{onDisconnected('푸시 알림 해독 실패');}},
 onError:()=>onDisconnected('푸시 연결 오류'),onDisconnected:()=>{close();onDisconnected('푸시 재연결 중');}});
 // Channel ID must survive restarts together with the decryption keys.
 signal.addEventListener('abort',close,{once:true});
 let timer,abortReject;
 try{
  await beforeConnect({signal});
  if(signal.aborted)throw Error('중지');
  const endpoint=await Promise.race([client.connect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('푸시 연결 시간 초과')),20000);abortReject=()=>reject(Error('중지'));signal.addEventListener('abort',abortReject,{once:true});})]);
  if(signal.aborted)throw Error('중지');
  const next={uaid:client.getUaid(),channelId,endpoint,remoteBroadcasts:client.getRemoteBroadcasts(),decryptor:{jwk:decryptor.getJwk(),auth:decryptor.getAuthBase64url()}};
  if(endpoint!==state?.endpoint)await register(session,next,decryptor,{signal,fetcher,headersFor});
  await saveState(next);return{close:()=>{signal.removeEventListener('abort',close);close();}};
 }catch(e){close();signal.removeEventListener('abort',close);throw e;}finally{clearTimeout(timer);if(abortReject)signal.removeEventListener('abort',abortReject);}
}
