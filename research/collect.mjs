import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateArchive} from './evidence.mjs';
const dir='outputs/research';
await mkdir(dir,{recursive:true});
const cutoff = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(Date.now());
const url='https://fchart.stock.naver.com/sise.nhn?timeframe=day&count=6000&requestType=0&symbol=KOSPI';
const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('코스피 자료 요청 실패 '+response.status);
const xml=await response.text();
const bars=[...xml.matchAll(/<item data="([^"]+)"/g)].map(match=>{
  const [raw,open,high,low,close,volume]=match[1].split('|');
  return {date:raw.slice(0,4)+'-'+raw.slice(4,6)+'-'+raw.slice(6,8),
    open:Number(open),high:Number(high),low:Number(low),close:Number(close),volume:Number(volume)};
}).filter(b=>b.date>='2026-05-01'&&b.date<cutoff);
if(!bars.length||bars.some(b=>![b.open,b.high,b.low,b.close].every(p=>Number.isFinite(p)&&p>0)||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)))throw Error('일봉 자료 검증 실패');
await writeFile(dir+'/kospi-daily.json',JSON.stringify({url,retrievedAt:new Date().toISOString(),bars},null,2));
let archive={market:'KR',start:'2026-05-01',events:[],snapshots:[]};
try{archive=JSON.parse(await readFile(dir+'/historical-archive.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const errors=validateArchive(archive);
const manifest={status:errors.length?'blocked':'ready',start:bars[0].date,end:bars.at(-1).date,sessions:bars.length,
  indexPriceReturnPct:(bars.at(-1).close/bars[0].open-1)*100,
  dataHash:createHash('sha256').update(JSON.stringify(bars)).digest('hex'),
  missing:errors,
  reason:'코스피 지수 가격변동은 참고 기준이다. 운영 전략의 순수익 백테스트에는 당시 후보·뉴스·공시·호가 재현이 필요하다.'};
await writeFile(dir+'/manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
