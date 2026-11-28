import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeCandle } from './chart-candles.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (status, message) => Object.assign(Error(message), { status });
export function researchRange(start, end, now = Date.now()) {
  if (![start, end].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && Number.isFinite(Date.parse(d+'T00:00:00Z')) && new Date(d+'T00:00:00Z').toISOString().slice(0,10) === d)) throw fail(400, '날짜를 확인해 주세요.');
  const today = new Date(now + 9*3600000).toISOString().slice(0,10);
  if (start < '2022-11-23' || start > end || end >= today || Date.parse(end)-Date.parse(start) > 366*86400000) throw fail(400, '완료된 과거 날짜로 최대 1년을 선택해 주세요.');
  return { start, end, from: Date.parse(start+'T00:00:00+09:00'), until: Date.parse(end+'T23:59:59+09:00') };
}

// Local-only files are selected by the authenticated server identity, never a request path.
export function createLocalResearch({ root, readPage, delay = pause, now = () => Date.now() }) {
  const running = new Map(), starting = new Set();
  function directory(id) {
    if (id !== 'owner' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw fail(400, '계정을 확인해 주세요.');
    return join(root, ...(id === 'owner' ? [] : ['users', id]), 'research');
  }
  async function saved(id) { try { return JSON.parse(await readFile(join(directory(id),'manifest.json'),'utf8')); } catch (e) { if (e.code==='ENOENT') return null; throw e; } }
  async function status(id) {
    const item=running.get(id);
    if(item){
      const manifest=structuredClone(item.manifest);
      // A terminal result is resumable only after its final checkpoint has
      // committed and the running slot has been released.
      return manifest.status==='running'?manifest:{...manifest,status:'running',message:'마지막 진행 상태를 저장하고 있습니다.'};
    }
    const manifest=await saved(id);
    if(manifest?.status==='running') return {...manifest,status:'interrupted',message:'서버 재시작으로 중단되었습니다. 이어받기를 누르세요.'};
    return manifest ?? {status:'idle',message:'기존 연결로 과거 분봉을 수집합니다.'};
  }
  async function start(id, env, options) {
    if(typeof readPage !== 'function') throw fail(503,'이 서버에서는 자료 수집을 사용할 수 없습니다.');
    if(running.has(id)||starting.has(id)) throw fail(409,'이미 수집 중입니다.');
    starting.add(id);
    try { return await begin(id,env,options); } finally {starting.delete(id);}
  }
  async function begin(id, env, options) {
    const range=researchRange(options.start,options.end,now());
    const prior=await saved(id);
    if(prior && (prior.start!==range.start || prior.end!==range.end)) throw fail(409,'기존 수집 범위가 있습니다. 현재 범위로 이어받아 주세요.');
    const dir=directory(id); await mkdir(dir,{recursive:true});
    const manifest=prior ?? {start:range.start,end:range.end,source:'Toss',universe:'current-KOSPI-not-historical',completed:[],unavailable:[],pages:0,bars:0,createdAt:now()};
    manifest.status='running';delete manifest.errorStatus;manifest.message='기존 API 연결을 확인하고 있습니다.';
    const item={manifest,stop:false};running.set(id,item);
    async function persist(){manifest.updatedAt=now();const file=join(dir,'manifest.json');await writeFile(file+'.tmp',JSON.stringify(manifest,null,2));await rename(file+'.tmp',file);}
    item.task=(async()=>{
      try {
        await persist();
        if(!manifest.symbols){
          const listing=await readPage(env,'stocks');
          const stocks=Array.isArray(listing)?listing:listing?.stocks;
          if(!Array.isArray(stocks)||!stocks.length) throw fail(502,'종목 목록을 확인하지 못했습니다.');
          manifest.stocks=stocks.filter(s=>/^[A-Z0-9]{6}$/.test(s.symbol)).map(s=>({symbol:s.symbol,name:s.name,type:s.securityType}));
          manifest.symbols=[...new Set(manifest.stocks.map(s=>s.symbol))];
          manifest.symbols.sort((a,b)=>(a==='005930'?-1:b==='005930'?1:a.localeCompare(b)));
          if(!manifest.symbols.length) throw fail(502,'유효한 코스피 종목이 없습니다.');
        }
        manifest.total=manifest.symbols.length;
        for(const symbol of manifest.symbols){
          if(item.stop)break;
          if(manifest.completed.includes(symbol)||manifest.unavailable.some(s=>s.symbol===symbol))continue;
          let progress=manifest.current?.symbol===symbol?manifest.current:{symbol,before:new Date(range.until).toISOString(),pages:0,bars:0};
          manifest.current=progress;
          const symbolDir=join(dir,symbol);await mkdir(symbolDir,{recursive:true});
          let finished=false;
          while(!item.stop&&!finished){
            await delay(400); // One request at a time; the existing common transport applies further pacing.
            let page;
            try { page=await readPage(env,'candles',{symbol,before:progress.before}); }
            catch(e){if(e.status===404){manifest.unavailable.push({symbol,status:404});finished=true;break;}throw e;}
            if(!Array.isArray(page?.candles))throw fail(502,'분봉 응답을 확인하지 못했습니다.');
            const times=page.candles.map(c=>Date.parse(c.timestamp));
            if(times.some(t=>!Number.isFinite(t)||t>Date.parse(progress.before))||page.candles.some(c=>!normalizeCandle(c,'KRW')))throw fail(502,'분봉 시각·가격·통화를 확인하지 못했습니다.');
            const candles=page.candles.filter((c,i)=>times[i]>=range.from&&times[i]<=range.until);
            const next=page.nextBefore;
            const oldest=times.length?Math.min(...times):Infinity;
            finished=oldest<=range.from||!next;
            if(!finished&&(!times.length||!Number.isFinite(Date.parse(next))||Date.parse(next)>=Date.parse(progress.before)))throw fail(502,'과거 페이지가 진행되지 않아 중단했습니다.');
            // Save raw pages separately; inclusive boundary duplicates must be removed during import.
            const file=join(symbolDir,String(progress.pages).padStart(5,'0')+'.json.gz');
            await writeFile(file+'.tmp',gzipSync(JSON.stringify({symbol,before:progress.before,nextBefore:next,checkedAt:now(),candles})));
            await rename(file+'.tmp',file);
            progress.pages++;progress.bars+=candles.length;manifest.pages++;manifest.bars+=candles.length;
            if(next)progress.before=next;
            manifest.message=symbol+' 과거 분봉 수집 중';
            await persist();
          }
          if(finished){if(!manifest.unavailable.some(s=>s.symbol===symbol))manifest.completed.push(symbol);manifest.current=null;await persist();}
        }
        manifest.status=item.stop?'paused':'finished';
        manifest.message=item.stop?'수집을 중단했습니다. 이어받기가 가능합니다.':'현재 코스피 목록의 과거 분봉 조회를 마쳤습니다. 당시 전체 종목·상장폐지 및 누락 검증은 별도입니다.';
      }catch(e){manifest.status='paused';manifest.errorStatus=e.status??null;manifest.message=[401,403,503].includes(e.status)?'기존 API 인증·연결을 확인한 뒤 이어받아 주세요.':'조회 오류로 중단했습니다. 저장한 페이지부터 이어받을 수 있습니다.';}
      finally {await persist();running.delete(id);}
    })();
    // Keep rejected filesystem writes from becoming an unhandled process rejection.
    item.task.catch(()=>{running.delete(id);});
    return structuredClone(manifest);
  }
  function stop(id){const item=running.get(id);if(item)item.stop=true;return {status:item?'stopping':'idle'};}
  return {start,status,stop, close(){if(!running.size)return;for(const item of running.values())item.stop=true;return Promise.allSettled([...running.values()].map(i=>i.task));}};
}
