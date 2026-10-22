import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('public',{recursive:true});await writeFile('public/.keep','');
import {build} from 'esbuild';
await build({stdin:{contents:"import {inject} from '@vercel/analytics'; inject();",resolveDir:process.cwd()},bundle:true,minify:true,platform:'browser',outfile:'public/analytics.js'});
