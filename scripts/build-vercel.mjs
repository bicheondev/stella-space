import {mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initialPage,memberHandles} from '../worker/index.js';
import {normalizeRealtimeOrigin,publicPage} from '../api/index.js';
import {build} from 'esbuild';
export async function buildVercel({output='public',origin=process.env.SPACELIVE_REALTIME_ORIGIN||''}={}){
 const realtimeOrigin=normalizeRealtimeOrigin(origin);
 await mkdir(output,{recursive:true});await cp(new URL('../assets/public/',import.meta.url),output,{recursive:true});await writeFile(join(output,'.keep'),'');
 await build({stdin:{contents:"import {inject} from '@vercel/analytics'; inject();",resolveDir:process.cwd()},bundle:true,minify:true,platform:'browser',outfile:join(output,'analytics.js')});
 // Vercel checks filesystem routes before the catch-all rewrite. Without the
 // origin these files are absent, preserving the staged dynamic deployment.
 const pages=[['/','index.html'],...memberHandles.map(handle=>['/'+handle,handle+'.html'])];
 await Promise.all(pages.map(([,file])=>rm(join(output,file),{force:true})));
 if(realtimeOrigin)await Promise.all(pages.map(async([path,file])=>writeFile(join(output,file),publicPage(await initialPage(null,path),realtimeOrigin))));
 return{staticPages:realtimeOrigin?pages.length:0,realtimeOrigin};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await buildVercel();
