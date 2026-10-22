import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('public',{recursive:true});await writeFile('public/.keep','');
