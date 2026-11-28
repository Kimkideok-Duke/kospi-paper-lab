import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeCandle} from '../server/chart-candles.mjs';

export function auditPages(pages,{from,until,expectedDates=[],complete=false}={}){
  if(!Array.isArray(pages)||!Number.isFinite(from)||!Number.isFinite(until)||from>until)throw Error('Invalid candle audit range');
  const bars=new Map(),errors=new Set();let total=0,duplicates=0,conflicts=0,prior=null;
  for(const page of pages){
    if(!Array.isArray(page?.candles)){errors.add('invalid-page');continue;}
    const before=Date.parse(page.before);
    if(!Number.isFinite(before)||(prior&&before!==Date.parse(prior.nextBefore)))errors.add('broken-page-chain');
    if(page.candles.length>200)errors.add('page-size-exceeded');
    let priorTime=Infinity;
    for(const raw of page.candles){
      total++;const bar=raw&&typeof raw==='object'?normalizeCandle(raw,'KRW'):null;
      if(!bar){errors.add('invalid-candle');continue;}
      if(bar.time<from||bar.time>until||bar.time>before)errors.add('outside-requested-range');
      if(bar.time>priorTime)errors.add('unordered-page');priorTime=bar.time;
      const previous=bars.get(bar.time);
      if(previous){duplicates++;if(JSON.stringify(previous)!==JSON.stringify(bar)){conflicts++;errors.add('conflicting-boundary-candle');}}
      else bars.set(bar.time,bar);
    }
    if(page.nextBefore!=null&&(!Number.isFinite(Date.parse(page.nextBefore))||Date.parse(page.nextBefore)>=before))errors.add('non-progressing-cursor');
    prior=page;
  }
  const ordered=[...bars.values()].sort((a,b)=>a.time-b.time),dateOf=t=>new Date(t+9*3600000).toISOString().slice(0,10);
  const dates=new Set(ordered.map(b=>dateOf(b.time)));let intraDayGaps=0,largestGapMinutes=0;
  for(let i=1;i<ordered.length;i++)if(dateOf(ordered[i].time)===dateOf(ordered[i-1].time)){
    const gap=(ordered[i].time-ordered[i-1].time)/60000;if(gap>1){intraDayGaps++;largestGapMinutes=Math.max(largestGapMinutes,gap);}
  }
  return {status:errors.size?'invalid':'checked',pages:pages.length,rawBars:total,uniqueBars:bars.size,boundaryDuplicates:duplicates,conflicts,
    first:ordered.length?new Date(ordered[0].time).toISOString():null,last:ordered.length?new Date(ordered.at(-1).time).toISOString():null,
    observedDays:dates.size,unobservedDates:expectedDates.filter(d=>!dates.has(d)),intraDayGaps,largestGapMinutes,
    providerTraversalFinished:complete,pointInTimeUniverseVerified:false,errors:[...errors]};
}

export async function auditDownloadedCandles(root,{maxSymbols=3,indexFile='outputs/research/kospi-daily.json'}={}){
  if(!Number.isSafeInteger(maxSymbols)||maxSymbols<1||maxSymbols>2500)throw Error('Invalid audit symbol limit');
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  const index=JSON.parse(await readFile(indexFile,'utf8'));
  const from=Date.parse(manifest.start+'T00:00:00+09:00'),until=Date.parse(manifest.end+'T23:59:59+09:00');
  if(!Number.isFinite(from)||!Number.isFinite(until)||from>until)throw Error('Invalid collected range');
  const dates=index.bars.map(b=>b.date).filter(d=>d>=manifest.start&&d<=manifest.end);
  const selected=[...(manifest.completed??[]).slice(0,maxSymbols),...(manifest.current?[manifest.current.symbol]:[])];
  const results=[];
  for(const symbol of [...new Set(selected)]){
    if(!/^[A-Z0-9]{6}$/.test(symbol))throw Error('Invalid collected symbol');
    const dir=join(root,symbol),complete=(manifest.completed??[]).includes(symbol);
    const files=(await readdir(dir)).filter(f=>/^\d+\.json\.gz$/.test(f)).sort()
      .filter(f=>complete||Number(f.split('.')[0])<manifest.current.pages);
    const pages=[];
    for(let i=0;i<files.length;i++){
      if(Number(files[i].split('.')[0])!==i)throw Error('Missing checkpoint page');
      const page=JSON.parse(gunzipSync(await readFile(join(dir,files[i]))));
      if(page.symbol!==symbol)throw Error('Mismatched page symbol');pages.push(page);
    }
    results.push({symbol,...auditPages(pages,{from,until,expectedDates:dates,complete})});
  }
  return {checkedAt:new Date().toISOString(),range:{start:manifest.start,end:manifest.end},collection:{status:manifest.status,
    finishedSymbols:manifest.completed?.length??0,targetSymbols:manifest.total,storedPages:manifest.pages,rawBars:manifest.bars},
    checkedSymbols:results.length,scope:'bounded sample of completed symbols plus checkpointed current symbol',results,
    note:'가격값은 출력하지 않는 비공개 수집 점검. 미관측 날짜·분 간격은 상장·거래정지·장 일정과 별도 대조해야 하며 전체 구성종목·호가·뉴스 재현 완료가 아니다.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await auditDownloadedCandles(join(process.env.LOCALAPPDATA,'MarketLab','research'));
  await mkdir('outputs/research',{recursive:true});await writeFile('outputs/research/candle-audit.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({collection:report.collection,checkedSymbols:report.checkedSymbols,
    checks:report.results.map(r=>({symbol:r.symbol,status:r.status,pages:r.pages,uniqueBars:r.uniqueBars,duplicates:r.boundaryDuplicates,
      observedDays:r.observedDays,unobservedDays:r.unobservedDates.length,first:r.first,last:r.last,errors:r.errors}))}));
}
