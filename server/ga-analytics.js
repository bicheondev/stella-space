import {createPrivateKey,sign} from 'node:crypto';
import {encryptToken,decryptToken} from './visitor-analytics.js';
const base='https://analyticsdata.googleapis.com/v1beta/properties/';
const message=status=>status===401||status===403?'Google Analytics Data API 사용 설정과 서비스 계정의 속성 뷰어 권한을 확인해 주세요.':status===429?'GA 조회 제한으로 잠시 후 재시도합니다.':'GA 보고서 조회 오류 ('+status+')';
export function validateGaConfig(propertyId,credentials){
 if(!/^\d{1,15}$/.test(String(propertyId||'')))throw Error('숫자로 된 GA4 속성 ID를 입력해 주세요. 측정 ID(G-…)와 다릅니다.');
 let c;try{c=typeof credentials==='string'?JSON.parse(credentials):credentials}catch{throw Error('서비스 계정 JSON 형식을 확인해 주세요.')}
 if(c?.type!=='service_account'||typeof c.client_email!=='string'||!/@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i.test(c.client_email)||typeof c.private_key!=='string'||c.private_key.length>20000)throw Error('Google 서비스 계정 키 JSON을 입력해 주세요.');
 try{if(createPrivateKey(c.private_key).asymmetricKeyType!=='rsa')throw Error();}catch{throw Error('서비스 계정 비공개 키를 확인해 주세요.')}
 return{propertyId:String(propertyId),credentials:{type:'service_account',client_email:c.client_email,private_key:c.private_key}};
}
async function accessToken(config,fetcher,now){
 const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const iat=Math.floor(now/1000),unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:config.credentials.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:'https://oauth2.googleapis.com/token',iat,exp:iat+3600});
 const assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),config.credentials.private_key).toString('base64url');
 const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error('GA 서비스 계정 인증에 실패했습니다. 키 상태와 계정 권한을 확인해 주세요.');const b=await r.json();if(!b.access_token)throw Error('GA 인증 응답을 확인하지 못했습니다.');return b.access_token;
}
async function report(config,token,dimension,startDate,fetcher){
 const body={dateRanges:[{startDate,endDate:'today'}],metrics:[{name:'activeUsers'},{name:'screenPageViews'}],...(dimension?{dimensions:[{name:dimension}],limit:'30',orderBys:[dimension==='date'?{dimension:{dimensionName:'date'}}:{metric:{metricName:'screenPageViews'},desc:true}]}:{})};
 const r=await fetcher(base+config.propertyId+':runReport',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(message(r.status));return r.json();
}
const metrics=r=>({visitors:Number(r.metricValues?.[0]?.value||0),pageviews:Number(r.metricValues?.[1]?.value||0)});
export async function gaReports(config,{now=Date.now(),fetcher=fetch}={}){
 const token=await accessToken(config,fetcher,now);const [today,daily,countries,referrers,pages]=await Promise.all([report(config,token,null,'today',fetcher),...['date','country','sessionSourceMedium','pagePath'].map(d=>report(config,token,d,'6daysAgo',fetcher))]);
 const map=(r,key)=>(r.rows||[]).map(row=>({[key]:row.dimensionValues?.[0]?.value||'',...metrics(row)}));
 return {source:'Google Analytics 4',status:'connected',checkedAt:now,timezone:today.metadata?.timeZone||daily.metadata?.timeZone||'GA 속성 시간대',propertyId:config.propertyId,totals:today.rows?.[0]?metrics(today.rows[0]):{visitors:0,pageviews:0},daily:map(daily,'timestamp').map(r=>({...r,timestamp:r.timestamp.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3T00:00:00')})),countries:map(countries,'country'),referrers:map(referrers,'referrerHostname'),pages:map(pages,'requestPath')};
}
export async function saveGaConfig(db,propertyId,credentials){
 const config=validateGaConfig(propertyId,credentials);const data=await gaReports(config);
 for(const [key,value]of [['ga_config',encryptToken(JSON.stringify(config))],['ga_cache',JSON.stringify(data)]])await db.prepare(`INSERT INTO operations_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key`).bind(key,value).first();
}
export async function gaAnalytics(db,options={}){
 const row=await db.prepare(`SELECT value FROM operations_settings WHERE key='ga_config'`).bind().first();
 const config=row?JSON.parse(decryptToken(row.value)):process.env.GA_PROPERTY_ID&&process.env.GA_SERVICE_ACCOUNT_JSON?validateGaConfig(process.env.GA_PROPERTY_ID,process.env.GA_SERVICE_ACCOUNT_JSON):null;
 if(!config)return{source:'Google Analytics 4',status:'disconnected',message:'GA 태그는 설치되어 있습니다. 통계를 표시하려면 속성 ID와 뷰어 권한이 있는 서비스 계정 키를 연결해 주세요.'};
 let previous;try{const cache=await db.prepare(`SELECT value FROM operations_settings WHERE key='ga_cache'`).bind().first();previous=cache?JSON.parse(cache.value):null}catch{}
 const now=options.now??Date.now();if(previous&&now-previous.checkedAt<120000)return previous;
 try{const data=await gaReports(config,options);await db.prepare(`INSERT INTO operations_settings(key,value) VALUES('ga_cache',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key`).bind(JSON.stringify(data)).first();return data}catch(e){return{...(previous||{}),source:'Google Analytics 4',status:previous?'stale':'error',message:e.message}}
}
