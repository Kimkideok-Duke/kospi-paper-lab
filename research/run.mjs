import {readFile,writeFile} from 'node:fs/promises';
import {searchArchive} from './replay.mjs';
let archive={market:'KR',start:'2026-05-01',events:[],snapshots:[]};
try{archive=JSON.parse(await readFile('outputs/research/historical-archive.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const manifest=JSON.parse(await readFile('outputs/research/manifest.json','utf8'));
const result=searchArchive(archive,manifest.end);
await writeFile('outputs/research/backtest.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({status:result.status,errors:result.errors,candidate:result.candidate,promote:result.promote}));
