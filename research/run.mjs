import {readFile,writeFile} from 'node:fs/promises';
import {searchArchive,REFERENCE_PARAMETERS} from './replay.mjs';
const referenceParameters={...REFERENCE_PARAMETERS};
for(const [key,flag] of [['momentum','--reference-momentum='],['spread','--reference-spread=']]){
  const arg=process.argv.find(v=>v.startsWith(flag));if(!arg)continue;
  const raw=arg.slice(flag.length),value=Number(raw);
  if(!raw.trim()||!Number.isFinite(value)||value<0||value>10)throw Error('유효한 기준선 조건을 지정해 주세요.');
  referenceParameters[key]=value;
}
let archive={market:'KR',start:'2026-05-01',events:[],snapshots:[]};
try{archive=JSON.parse(await readFile('outputs/research/historical-archive.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const manifest=JSON.parse(await readFile('outputs/research/manifest.json','utf8'));
const result=searchArchive(archive,manifest.end,{referenceParameters});
result.referenceParameters=referenceParameters;
await writeFile('outputs/research/backtest.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({status:result.status,errors:result.errors,candidate:result.candidate,promote:result.promote,referenceParameters}));
