import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync,existsSync}from'node:fs';import{initialPage}from'../worker/index.js';
test('share metadata resolves canonical member paths and references correctly sized brand images',async()=>{
 const html=await initialPage(null,'/ShirayukiHina_');assert(html.includes('<title>스페라이브</title>'));assert(!html.includes('__PUBLIC_URL__'));assert(html.includes('href="https://spacelive.vercel.app/ShirayukiHina_"'));
 const root=await initialPage(null,'/<script>');assert(root.includes('href="https://spacelive.vercel.app/"'));
 for(const[name,w,h]of[['brand/og.png',1200,630],['brand/x-card.png',1200,600],['apple-touch-icon.png',180,180],['icon-192.png',192,192],['icon-512.png',512,512]]){const bytes=readFileSync(new URL('../assets/public/'+name,import.meta.url));assert.equal(bytes.readUInt32BE(16),w);assert.equal(bytes.readUInt32BE(20),h);}
 for(const path of['favicon.svg','favicon.ico','site.webmanifest'])assert(existsSync(new URL('../assets/public/'+path,import.meta.url)));
 const manifest=JSON.parse(readFileSync(new URL('../assets/public/site.webmanifest',import.meta.url)));assert.equal(manifest.name,'스페라이브');
});
