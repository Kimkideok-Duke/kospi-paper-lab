// Public feeds are shared across users. No account identifiers or Toss credentials leave this module.
import { openingSignal, articleSignals, relevantTopics } from './us-news.mjs';
export const EVENT_POLICY = Object.freeze({ newsMs: 120000, disclosureMs: 60000, officialMs: 300000,
  closedMs: 900000, reactionMs: 60000, reanalysisMs: 120000, actionableMs: 20 * 60000, retentionMs: 24 * 3600000 });
export const EVENT_FEEDS = [
  { id: 'dart', name: 'DART', host: 'dart.fss.or.kr', kind: 'disclosure', markets: ['KR'], interval: 60000, url: 'https://dart.fss.or.kr/api/todayRSS.xml' },
  { id: 'kind', name: 'KIND', host: 'kind.krx.co.kr', kind: 'disclosure', markets: ['KR'], interval: 60000, url: 'https://kind.krx.co.kr/disclosure/rsstodaydistribute.do?method=searchRssTodayDistribute&repIsuSrtCd=&mktTpCd=0&searchCorpName=&currentPageSize=100' },
  { id: 'sec', name: 'SEC EDGAR', host: 'sec.gov', kind: 'disclosure', markets: ['US'], interval: 60000, url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&count=100&output=atom' },
  { id: 'sec-tickers', name: 'SEC 기업 식별표', host: 'sec.gov', kind: 'mapping', markets: ['US'], interval: 86400000, url: 'https://www.sec.gov/files/company_tickers.json' },
  { id: 'yonhap', name: '연합뉴스', host: 'yna.co.kr', kind: 'news', markets: ['KR'], interval: 120000, url: 'https://www.yna.co.kr/rss/economy.xml' },
  { id: 'hankyung', name: '한국경제', host: 'hankyung.com', kind: 'news', markets: ['KR'], interval: 120000, url: 'https://www.hankyung.com/feed/finance' },
  { id: 'cnbc', name: 'CNBC', host: 'cnbc.com', kind: 'news', markets: ['KR', 'US'], interval: 120000, url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'npr', name: 'NPR', host: 'npr.org', kind: 'news', markets: ['KR', 'US'], interval: 120000, url: 'https://feeds.npr.org/1006/rss.xml' },
  { id: 'fed', name: '미 연준', host: 'federalreserve.gov', kind: 'official', markets: ['KR', 'US'], interval: 300000, url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
  { id: 'bls', name: '미 노동통계국', host: 'bls.gov', kind: 'official', markets: ['KR', 'US'], interval: 300000, url: 'https://www.bls.gov/feed/bls_latest.rss' },
  { id: 'bea', name: '미 경제분석국', host: 'bea.gov', kind: 'official', markets: ['KR', 'US'], interval: 300000, url: 'https://apps.bea.gov/rss/rss.xml' },
];
const strip = text => String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
  .replace(/&#x([a-f\d]+);/gi, (_, n) => Number.parseInt(n,16) <= 0x10ffff ? String.fromCodePoint(Number.parseInt(n,16)) : '')
  .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
  .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' ' })[n]).replace(/\s+/g,' ').trim();
const tag = (xml, name) => strip(xml.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'))?.[1]);
function safeLink(value, host) {
  try { const url = new URL(value); if (url.protocol === 'http:' && url.hostname.endsWith(host)) url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === host || url.hostname.endsWith('.'+host))) return null;
    url.hash=''; for(const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid)/i.test(key)) url.searchParams.delete(key);
    return url.href.length <= 700 ? url.href : null;
  } catch { return null; }
}
const normal = title => title.toLowerCase().replace(/\[(?:속보|단독|breaking|exclusive)\]/gi,'').replace(/[^\p{L}\p{N}]+/gu,'');
export function parseEventFeed(xml, feed, now) {
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY') || !/<(?:rss|feed)\b/i.test(xml) || !/<\/(?:rss|feed)>/i.test(xml)) throw Error('invalid-feed');
  const atom = /<feed\b/i.test(xml), rows = [...xml.matchAll(atom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return rows.slice(0,250).flatMap(([, item]) => {
    const title=tag(item,'title').slice(0,200), time=Date.parse(tag(item,atom?'updated':'pubDate')||tag(item,'dc:date'));
    const link=safeLink(atom ? strip(item.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1]) : tag(item,'link'),feed.host);
    if (!title || !link || !Number.isFinite(time) || time>now+3000 || time<now-EVENT_POLICY.retentionMs) return [];
    const issuer = feed.id==='dart' ? title.match(/^\([^)]*\)\s*(.+?)\s+-\s+/)?.[1] : feed.id==='kind' ? title.match(/^\[[^\]]*\]\s*(\S+)/)?.[1] : feed.id==='sec' ? title.match(/^[A-Z0-9/ -]+?\s+-\s*(.+?)\s*\(\d{1,10}\)/)?.[1] : null;
    const cik=feed.id==='sec'?title.match(/\((\d{1,10})\)/)?.[1]:null;
    const form=feed.id==='sec'?title.split(' - ')[0].trim():null;
    const receipt=link.match(/[?&](?:rcpNo|acptno)=(\d+)/i)?.[1];
    const fingerprint = receipt ? 'receipt:'+receipt : normal(title)+':'+new Date(time).toISOString().slice(0,10);
    return [{ id:feed.id+':'+(receipt??link),fingerprint,title,time,link,source:feed.name,sourceId:feed.id,kind:feed.kind,issuer:issuer??null,cik,form }];
  });
}
export function createEventCollector({ fetchImpl=(...a)=>fetch(...a), now=()=>Date.now(), sleep=ms=>new Promise(r=>setTimeout(r,ms)), feeds=EVENT_FEEDS }={}) {
  const cache=new Map(),inFlight=new Map(),lanes=new Map();
  async function get(feed) {
    const old=cache.get(feed.id);
    if(old&&now()<(old.status==='ok'?Math.min(old.nextAttempt,old.checkedAt+feed.interval):old.nextAttempt)) return old;
    if(inFlight.has(feed.id))return inFlight.get(feed.id);
    const task=(async()=>{
      const previous=lanes.get(feed.host)??{tail:Promise.resolve(),next:0};lanes.set(feed.host,previous);
      const operation=previous.tail.then(async()=>{
        const delay=Math.max(0,previous.next-now());if(delay)await sleep(delay);previous.next=now()+1100;
        const result={...old,id:feed.id,name:feed.name,kind:feed.kind,intervalMs:feed.interval,checkedAt:now(),items:old?.items??[]};
        try{
          const headers={'user-agent':'MarketLab/1.0 contact https://github.com/Kimkideok-Duke/kospi-paper-lab','accept':'application/rss+xml, application/atom+xml, application/xml, text/xml'};
          if(old?.etag)headers['if-none-match']=old.etag;if(old?.modified)headers['if-modified-since']=old.modified;
          const response=await fetchImpl(feed.url,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});
          if(response.status===304&&old?.successAt){result.successAt=now();result.status='ok';result.error=null;result.failures=0;result.nextAttempt=now()+feed.interval;}
          else{
            if(!response.ok){const raw=response.headers.get('retry-after'),retry=Number(raw),retryAfter=Number.isFinite(retry)&&retry>0?retry*1000:Math.max(0,Date.parse(raw)-now())||0;await response.body?.cancel();throw Object.assign(Error('http'),{status:response.status,retryAfter});}
            const reader=response.body.getReader(),chunks=[];let size=0;
            try{for(;;){const{value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>(feed.kind==='mapping'?5000000:1000000)){await reader.cancel();throw Error('oversize');}chunks.push(value);}}finally{reader.releaseLock();}
            const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
            const xml=new TextDecoder().decode(buffer);
            if(feed.kind==='mapping') {
              const rows=Object.values(JSON.parse(xml));
              if(!rows.length||rows.some(r=>!/^\d+$/.test(String(r.cik_str))||typeof r.ticker!=='string'))throw Error('invalid-mapping');
              result.mappings=rows.map(r=>({cik:String(Number(r.cik_str)),ticker:r.ticker.replace('-','.'),name:r.title}));result.items=[];
            } else result.items=parseEventFeed(xml,feed,now());
            result.successAt=now();result.status='ok';result.error=null;result.failures=0;
            result.etag=response.headers.get('etag');result.modified=response.headers.get('last-modified');result.nextAttempt=now()+feed.interval;
          }
        }catch(e){result.failures=(old?.failures??0)+1;result.status=e.status===403?'blocked':'error';result.error=e.status?'HTTP '+e.status:'피드 응답 확인 실패';
          result.nextAttempt=now()+Math.min(7*86400000,Math.max(e.status===403?1800000:Math.min(1800000,feed.interval*2**Math.min(result.failures-1,5)),e.retryAfter??0));
        }
        cache.set(feed.id,result);return result;
      });previous.tail=operation.catch(()=>{});return operation;
    })();inFlight.set(feed.id,task);try{return await task;}finally{inFlight.delete(feed.id);}
  }
  return { async collect(market,{closed=false}={}){const sources=await Promise.all(feeds.filter(f=>f.markets.includes(market)).map(f=>get({...f,interval:closed?Math.max(f.interval,EVENT_POLICY.closedMs):f.interval})));const time=now();
    const usable=sources.filter(s=>s.status==='ok'&&time-s.successAt<=Math.max(3*s.intervalMs,600000));
    const mappings=usable.flatMap(s=>s.mappings??[]),byCik=new Map();
    for(const row of mappings){if(!byCik.has(row.cik))byCik.set(row.cik,[]);byCik.get(row.cik).push(row.ticker);}
    return {checkedAt:time,sources:sources.map(({items,mappings,etag,modified,...rest})=>rest),items:usable.flatMap(s=>s.items).filter(i=>i.time<=time+3000&&i.time>=time-EVENT_POLICY.retentionMs)
      .map(i=>i.cik?{...i,symbols:byCik.get(String(Number(i.cik)))??[]}:i)};
  } };
}
export const marketEvents=createEventCollector();
const aliases={ AAPL:['Apple Inc','Apple'],MSFT:['Microsoft'],NVDA:['Nvidia'],AMD:['Advanced Micro Devices','AMD'],AMZN:['Amazon'],GOOGL:['Alphabet','Google'],GOOG:['Alphabet','Google'],META:['Meta Platforms'],TSLA:['Tesla'],AVGO:['Broadcom'],MU:['Micron'],HPQ:['HP Inc','Hewlett-Packard'],ADI:['Analog Devices'],ACN:['Accenture'],DE:['Deere'],INTC:['Intel'] };
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function matchesStock(item,stock) {
  if(item.symbols?.includes(stock.symbol))return true;
  if(item.issuer&&normal(item.issuer)===normal(stock.name))return true;
  const names=[stock.name,...aliases[stock.symbol]??[]].filter(v=>v&&v.length>=3);
  if(names.some(name=>/[가-힣]/.test(name)?item.title.includes(name):new RegExp('(?:^|[^a-z0-9])'+escape(name)+'(?:$|[^a-z0-9])','i').test(item.issuer??item.title)))return true;
  return new RegExp('(?:\\$|\\b(?:NASDAQ|NYSE|AMEX)\\s*[:：]\\s*)'+escape(stock.symbol)+'(?:$|[^A-Za-z0-9.])','i').test(item.title);
}
export function classifyEvent(item) {
  const title=item.title;
  const filingMaterial=item.kind==='disclosure'&&(item.sourceId==='sec'?/^(?:8-K|6-K|10-Q|10-K|NT 10-[KQ]|S-[13]|F-[13]|424B5|SC 13D)(?:\/A)?$/i.test(item.form??'')
    :/사업보고서|분기보고서|반기보고서|감사보고서|실적|자기주식|배당|증자|전환사채|신주인수권|합병|분할|영업.*[양수도]|소송|수주|계약|감사.*의견|거래정지|상장폐지|횡령|배임|회생|파산|대량보유/.test(title));
  if(/(?:사실무근|혐의\s*없|해당\s*없|해당하지|아니|않|무혐의|부인|루머|의혹|설[을이가은는\s]|검토|예정|추진|철회|취소)|\b(?:rumou?r|denies|not|no|without|avoids?|considering|may|could|plans to)\b/i.test(title))return {direction:0,critical:false,material:filingMaterial};
  const critical=/(?:감사의견.*(?:거절|부적정)|회생절차.*신청|파산.*신청|부도발생|상장폐지.*결정|횡령.*발생|배임.*발생)|\b(?:files? for bankruptcy|bankruptcy filing|auditor.*adverse opinion)\b/i.test(title);
  const down=critical||/(?:실적.*(?:쇼크|하회)|영업이익.*(?:감소|적자전환)|가이던스.*하향|유상증자.*결정|대규모.*리콜)|\b(?:cuts? (?:its )?(?:outlook|guidance)|miss(?:es)? (?:earnings |profit )?(?:estimates|expectations)|earnings miss)\b/i.test(title);
  const up=/(?:실적.*(?:서프라이즈|상회)|영업이익.*(?:증가|흑자전환)|공급계약.*체결|자기주식.*취득.*결정|자사주.*매입)|\b(?:raises? (?:its )?(?:outlook|guidance)|beats? (?:earnings |profit )?(?:estimates|expectations)|earnings beat|share buyback)\b/i.test(title);
  return {direction:up===down?0:down?-1:1,critical:critical&&item.kind==='disclosure',material:filingMaterial||up||down||item.kind==='official'||relevantTopics(title,item.source).length>0};
}
export function ingestEvents(state,snapshot,market,now) {
  const watch=state.eventWatch??={seen:[],initializedSources:[],items:[],blocks:{},reactions:[],pending:null,lastAnalysisAttempt:0};
  watch.sources=snapshot.sources;watch.lastChecked=snapshot.checkedAt;
  watch.seen=watch.seen.filter(s=>s.time>=now-EVENT_POLICY.retentionMs);
  watch.blocks=Object.fromEntries(Object.entries(watch.blocks).filter(([,b])=>b.until>now));
  const seen=new Set(watch.seen.map(s=>s.key)),initialized=new Set(watch.initializedSources),fresh=[];
  const stocks=[...new Map([...(state.positions??[]),...(state.universe?.stocks??[])].map(s=>[s.symbol,s])).values()];
  const items=[...snapshot.items].sort((a,b)=>b.time-a.time);
  for(const item of items){
    const key=item.kind==='news'?item.fingerprint+':'+item.source:item.fingerprint;if(seen.has(key))continue;seen.add(key);watch.seen.push({key,time:now});
    if(!initialized.has(item.sourceId)||now-item.time>EVENT_POLICY.actionableMs)continue;
    const classification=classifyEvent(item),matched=stocks.filter(s=>matchesStock(item,s));
    if(!classification.material)continue;
    // Generic filing types do not imply good/bad earnings. Hold new buys while price evidence is checked.
    for(const stock of matched)if(classification.direction<0||(item.kind==='disclosure'&&classification.direction===0)){
      watch.blocks[stock.symbol]={until:now+(classification.critical?24*3600000:classification.direction<0?30*60000:10*60000),direction:classification.direction,critical:classification.critical,event:item};
      for(const order of state.paperOrders??[])if(order.symbol===stock.symbol&&order.side==='BUY'&&['PENDING','PARTIAL_FILLED'].includes(order.status)){order.status='CANCELED';order.note='장중 뉴스·공시 감지: '+item.title;}
    }
    if(matched.length||item.kind==='official'||relevantTopics(item.title,item.source).length)fresh.push({...item,...classification,symbols:matched.map(s=>s.symbol)});
  }
  for(const source of snapshot.sources)if(source.status==='ok')initialized.add(source.id);
  watch.initializedSources=[...initialized];watch.items=items.slice(0,60);watch.seen=watch.seen.slice(-4000);
  for(const item of fresh)watch.reactions.push({time:now,title:item.title,link:item.link,source:item.source,symbols:item.symbols,direction:item.direction,action:item.direction<0?'매수 보류·보유 위험 재점검':item.kind==='disclosure'?'공시 감지·추가 분석 대기':'새 정보 감지·추가 분석 대기'});
  watch.reactions=watch.reactions.slice(-100);
  if(fresh.length)watch.pending={id:crypto.randomUUID(),createdAt:now,titles:fresh.slice(0,3).map(i=>i.title),symbols:[...new Set(fresh.flatMap(i=>i.symbols))]};
  if(watch.pending&&now-watch.pending.createdAt>EVENT_POLICY.actionableMs)watch.pending=null;
  watch.newCount=fresh.length;
  return fresh;
}
export function eventSignal(state,stock,now) {
  const watch=state.eventWatch,block=watch?.blocks?.[stock.symbol];
  if(block?.until>now)return {blocked:true,score:-2,caution:true,relevant:false,reason:'장중 공시·뉴스 확인 대기: '+block.event.title};
  const available=new Set((watch?.sources??[]).filter(s=>s.status==='ok'&&now-s.successAt<=Math.max(3*s.intervalMs,600000)).map(s=>s.id));
  const recent=(watch?.items??[]).filter(i=>available.has(i.sourceId)&&i.time<=now+3000&&now-i.time<=EVENT_POLICY.actionableMs);
  const direct=recent.filter(i=>matchesStock(i,stock)),positive=direct.filter(i=>classifyEvent(i).direction>0),negative=direct.filter(i=>classifyEvent(i).direction<0);
  const totals={market:0,rates:0,trade:0,chips:0,autos:0,energy:0};
  const evidence=new Map();
  for(const item of recent){const matched=relevantTopics(item.title,item.source),signals=articleSignals(item.title,'',item.source,matched);for(const key of Object.keys(totals))if(signals[key]){if(!evidence.has(key))evidence.set(key,new Map());evidence.get(key).set(item.source,{direction:signals[key],official:item.kind==='official'});}}
  for(const [key,bySource] of evidence)if(bySource.size>=2||[...bySource.values()].some(v=>v.official))totals[key]=[...bySource.values()].reduce((n,v)=>n+v.direction,0);
  const broad=totals.market+totals.rates+totals.trade;
  const macro=openingSignal({totals,stance:broad<0?'cautious':broad>0?'positive':'neutral'}, {...stock,marketCountry:/^[A-Z.-]+$/.test(stock.symbol)?'US':'KR'});
  const confirmed=positive.some(i=>i.kind==='disclosure')||new Set(positive.map(i=>i.source)).size>=2;
  return {blocked:negative.length>0,score:negative.length?-1:confirmed?1:macro.score,caution:negative.length>0||macro.caution,relevant:confirmed||macro.relevant,
    reason:negative.length?'장중 악재 확인: '+negative[0].title:confirmed?'장중 호재 교차 확인: '+positive[0].title:macro.reason};
}
export function eventExitReason(state,position,price,previous,now,market) {
  const block=state.eventWatch?.blocks?.[position.symbol];
  if(!block||block.until<=now||block.direction>=0)return null;
  const entry=market==='US'?position.entryUsd:position.entryPrice??position.entry;
  const change=base=>Number.isFinite(base)&&base>0?(price/base-1)*100:0;
  if(block.critical||Math.min(change(previous),change(entry))<=-.5)return '장중 '+block.event.source+' 악재'+(block.critical?' 공시 확인':'와 가격 약화 확인')+': '+block.event.title;
  return null;
}
export function eventsView(state,now) {
  const watch=state?.eventWatch;if(!watch)return {status:'waiting',lastChecked:null,sources:[],items:[],reactions:[],policy:EVENT_POLICY};
  const sources=(watch.sources??[]).map(s=>({...s,status:s.status==='ok'&&now-s.successAt>Math.max(3*s.intervalMs,600000)?'stale':s.status}));
  return {status:state.operations?.status==='closed'?'closed':sources.length&&sources.every(s=>s.status==='ok')?'ok':sources.some(s=>s.status==='ok')?'degraded':'unavailable',lastChecked:watch.lastChecked,sources,
    items:watch.items??[],reactions:(watch.reactions??[]).slice(-20),blocks:Object.entries(watch.blocks??{}).filter(([,b])=>b.until>now).map(([symbol,b])=>({symbol,until:b.until,title:b.event.title})),policy:EVENT_POLICY};
}
