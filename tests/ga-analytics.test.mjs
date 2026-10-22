import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {gaReports,validateGaConfig,gaAnalytics} from '../server/ga-analytics.js';
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),credentials={type:'service_account',client_email:'analytics@example-project.iam.gserviceaccount.com',private_key:pair.privateKey.export({type:'pkcs8',format:'pem'})};
test('GA connection rejects measurement IDs and invalid credentials',()=>{
 assert.throws(()=>validateGaConfig('G-QQYQ0W3JDC',credentials),/속성 ID/);assert.throws(()=>validateGaConfig('123456','not-json'),/JSON/);assert.throws(()=>validateGaConfig('123456',{...credentials,private_key:'invalid'}),/비공개 키/);
});
test('GA reports request only read scope and normalize GA metrics and property timezone',async()=>{
 const config=validateGaConfig('123456',credentials),calls=[];const fetcher=async(url,opts)=>{calls.push(String(url));if(String(url).includes('oauth2.googleapis.com')){const jwt=opts.body.get('assertion'),claim=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString());assert.equal(claim.scope,'https://www.googleapis.com/auth/analytics.readonly');assert.equal(claim.iss,credentials.client_email);return Response.json({access_token:'test-only'})}
 assert.equal(String(url),'https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport');assert.equal(opts.headers.Authorization,'Bearer test-only');const b=JSON.parse(opts.body);assert.deepEqual(b.metrics,[{name:'activeUsers'},{name:'screenPageViews'}]);if(!b.dimensions)assert(['today','6daysAgo','29daysAgo'].includes(b.dateRanges[0].startDate));const dim=b.dimensions?.[0]?.name,values={date:'20261022',country:'South Korea',sessionSourceMedium:'x.com / referral',pagePath:'/HanayoHiyori'};return Response.json({metadata:{timeZone:'Asia/Seoul'},rows:[{dimensionValues:dim?[{value:values[dim]}]:[],metricValues:[{value:'2'},{value:'7'}]}]})};
 const data=await gaReports(config,{fetcher,now:Date.parse('2026-10-22T10:00:00Z')});assert.equal(calls.length,8);assert.deepEqual(data.activeUsers,{dau:2,wau:2,mau:2});assert.equal(data.source,'Google Analytics 4');assert.equal(data.timezone,'Asia/Seoul');assert.equal(data.totals.visitors,2);assert.equal(data.daily[0].timestamp,'2026-10-22T00:00:00');assert.equal(data.referrers[0].referrerHostname,'x.com / referral');assert.equal(data.pages[0].requestPath,'/HanayoHiyori');assert(!JSON.stringify(data).includes('private_key'));
});
test('unconnected GA never returns Vercel statistics',async()=>{
 const db={prepare(){return{bind(){return{first:async()=>null}}}}};const data=await gaAnalytics(db);assert.equal(data.status,'disconnected');assert.equal(data.source,'Google Analytics 4');assert(!('totals'in data));
});
