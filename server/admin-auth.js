import{createHmac,createHash,randomBytes,timingSafeEqual,createCipheriv,createDecipheriv}from'node:crypto';
export const adminUserId=44262309;
const origin='https://spacelive.vercel.app',callback=origin+'/api/auth/github/callback',sessionName='__Host-spacelive_admin',flowName='__Host-spacelive_oauth',lifetime=12*3600;
export const privateHeaders={'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'",'X-Frame-Options':'SAMEORIGIN'};
const signature=value=>createHmac('sha256',process.env.ADMIN_SESSION_SECRET).update('spacelive-admin-v1:'+value).digest('base64url');
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
function cookieValue(raw,name){return raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
const cookie=(name,value,seconds)=>`${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seconds}`;
const flowKey=()=>createHash('sha256').update('spacelive-oauth-v1:'+process.env.ADMIN_SESSION_SECRET).digest();
function encryptFlow(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',flowKey(),iv);return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64url');}
function decryptFlow(value){const b=Buffer.from(value,'base64url'),c=createDecipheriv('aes-256-gcm',flowKey(),b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8');}
export function adminSessionCookie({now=Date.now()}={}){if(!process.env.ADMIN_SESSION_SECRET)throw Error('관리자 인증 설정이 필요합니다.');const value=Buffer.from(JSON.stringify({sub:adminUserId,iat:now,exp:now+lifetime*1000,nonce:randomBytes(16).toString('base64url')})).toString('base64url');return cookie(sessionName,value+'.'+signature(value),lifetime);}
export function authorized(raw='',{now=Date.now()}={}){if(!process.env.ADMIN_SESSION_SECRET||typeof raw!=='string'||raw.length>8192)return false;try{const token=cookieValue(raw,sessionName),parts=token.split('.');if(parts.length!==2||!equal(parts[1],signature(parts[0])))return false;const d=JSON.parse(Buffer.from(parts[0],'base64url'));return d.sub===adminUserId&&Number.isSafeInteger(d.iat)&&Number.isSafeInteger(d.exp)&&d.iat<=now&&d.exp>now&&d.exp-d.iat===lifetime*1000;}catch{return false;}}
function response(body,status=200,extra={}){return new Response(body,{status,headers:{...privateHeaders,...extra}})}
function redirect(location,cookies=[]){const r=response(null,303,{Location:location});for(const c of cookies)r.headers.append('Set-Cookie',c);return r;}
export function loginPage({ready=false,denied=false,next='/ops'}={}){return response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>스페라이브 · 운영 로그인</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:15px/1.6 system-ui;background:light-dark(#fff,#000);color:light-dark(#0f1419,#e7e9ea)}main{max-width:calc(100% - 40px);text-align:center}p{max-width:360px;color:light-dark(#59636e,#9198a1)}a{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:32px;padding:5px 12px;border:1px solid light-dark(#d1d9e0,#3d444d);border-radius:6px;background:light-dark(#f6f8fa,#212830);color:light-dark(#1f2328,#f0f6fc);font-size:14px;line-height:20px;font-weight:500;text-decoration:none;box-shadow:0 1px 0 light-dark(#1f23280a,#0104090a)}a:hover{background:light-dark(#eff2f5,#262c36)}a:active{background:light-dark(#e6eaef,#2a313c)}a:focus-visible{outline:2px solid #0969da;outline-offset:2px}a svg{flex-shrink:0;fill:currentColor}</style><main>${denied?'<p>접근이 거부됐거나 로그인이 만료됐습니다. 다시 로그인해 주세요.</p>':ready?'':'<p>GitHub 로그인 연결을 준비하고 있습니다. 운영 기능은 잠겨 있습니다.</p>'}${ready?'<a href="/api/auth/github'+(next==='/ops/debug'?'?next=debug':'')+'"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg><span>Sign in with GitHub</span></a>':''}</main></html>`,ready?denied?403:200:503,{'Content-Type':'text/html;charset=utf-8'});}
function configured(){return !!(process.env.ADMIN_SESSION_SECRET&&process.env.GITHUB_OAUTH_CLIENT_ID?.trim()&&process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim());}
export async function adminAuth(req,url,{fetcher=fetch,now=Date.now()}={}){
 const path=url.pathname,ready=configured();
 if(path==='/api/auth/logout'){if(req.method!=='POST')return response(null,405);if(req.headers.origin!==origin)return response(null,403);return redirect('/ops',[cookie(sessionName,'',0),cookie(flowName,'',0),'ops=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);}
 if(path==='/api/auth/github'){
  if(req.method!=='GET')return response(null,405);if(!ready)return loginPage();if(url.origin!==origin)return redirect(origin+path);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),next=url.searchParams.get('next')==='debug'?'/ops/debug':'/ops';
  const flow=encryptFlow(JSON.stringify({state,verifier,next,expires:now+600000}));const target=new URL('https://github.com/login/oauth/authorize');target.search=new URLSearchParams({client_id:process.env.GITHUB_OAUTH_CLIENT_ID.trim(),redirect_uri:callback,scope:'',login:'bicheondev',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',allow_signup:'false'});return redirect(target.href,[cookie(flowName,encodeURIComponent(flow),600)]);
 }
 if(path==='/api/auth/github/callback'){
  if(req.method!=='GET')return response(null,405);
  const clear=cookie(flowName,'',0),fail=()=>redirect('/ops?login=denied',[clear,cookie(sessionName,'',0)]);
  if(!ready||url.origin!==origin||url.searchParams.has('error'))return fail();
  try{
   const flow=JSON.parse(decryptFlow(decodeURIComponent(cookieValue(req.headers.cookie||'',flowName)))),state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
   if(!equal(state,flow.state)||!Number.isSafeInteger(flow.expires)||flow.expires<=now||flow.expires>now+600000||!code||code.length>512||!['/ops','/ops/debug'].includes(flow.next))return fail();
   const tokenResponse=await fetcher('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GITHUB_OAUTH_CLIENT_ID.trim(),client_secret:process.env.GITHUB_OAUTH_CLIENT_SECRET.trim(),code,redirect_uri:callback,code_verifier:flow.verifier}),signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!tokenResponse.ok)return fail();const token=await tokenResponse.json();if(typeof token.access_token!=='string'||token.error)return fail();
   const userResponse=await fetcher('https://api.github.com/user',{headers:{Authorization:'Bearer '+token.access_token,Accept:'application/vnd.github+json','User-Agent':'Spacelive-Console','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!userResponse.ok)return fail();const user=await userResponse.json();if(user.id!==adminUserId)return fail();
   return redirect(flow.next,[clear,adminSessionCookie({now}),'ops=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);
  }catch{return fail();}
 }
 if(path==='/ops'||path==='/ops/debug'){if(req.method&&req.method!=='GET')return response(null,405);if(!authorized(req.headers.cookie,{now}))return loginPage({ready,denied:url.searchParams.get('login')==='denied',next:path});}
 if(path.startsWith('/ops-'))return redirect(path.endsWith('/debug')?'/ops/debug':'/ops');
 if(path.startsWith('/api/admin/')&&!authorized(req.headers.cookie,{now}))return response(JSON.stringify({error:'Not found'}),404,{'Content-Type':'application/json'});
 return null;
}
