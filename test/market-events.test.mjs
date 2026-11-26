import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventCollector, parseEventFeed, classifyEvent, ingestEvents, eventSignal, eventExitReason, eventsView, EVENT_POLICY } from '../server/market-events.mjs';
import { initialState, execute } from '../server/engine.mjs';
import { upgradePaper } from '../server/paper-model.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import '../scripts/build.mjs';
const {runMonitor,default:app}=await import('../dist/server/index.js');
const now=Date.parse('2026-11-26T10:00:00+09:00');
const feed={id:'dart',name:'DART',host:'dart.fss.or.kr',kind:'disclosure',markets:['KR'],interval:60000,url:'https://dart.fss.or.kr/api/todayRSS.xml'};
const xml=(title,time=now,link='https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202611260001')=>`<rss><channel><item><title><![CDATA[${title}]]></title><link>${link.replaceAll('&','&amp;')}</link><pubDate>${new Date(time).toUTCString()}</pubDate></item></channel></rss>`;
const source=(id='dart',name='DART',kind='disclosure')=>({id,name,kind,status:'ok',successAt:now,checkedAt:now,intervalMs:60000,nextAttempt:now+60000});
function item(title='(유가)삼성전자 - 유상증자결정',extra={}){return {...parseEventFeed(xml(title),feed,now)[0],...extra};}
const snapshot=items=>({checkedAt:now,sources:[source()],items});
const state=()=>{const s=upgradePaper(initialState(),'KR',now);s.universe={date:'2026-11-26',stocks:[{symbol:'005930',name:'삼성전자',type:'주식'}]};return s;};
test('RSS/Atom parsing enforces timestamps, issuer/receipt identity and source-host links without fetching article URLs',()=>{
  const rows=parseEventFeed(xml('(유가)삼성전자 - 공급계약체결'),feed,now);
  assert.equal(rows[0].issuer,'삼성전자');assert.equal(rows[0].fingerprint,'receipt:202611260001');
  assert.equal(parseEventFeed(xml('bad',now,'https://evil.example/article'),feed,now).length,0);
  assert.equal(parseEventFeed(xml('future',now+60000),feed,now).length,0);
  assert.equal(parseEventFeed(xml('old',now-EVENT_POLICY.retentionMs-1000),feed,now).length,0);
  assert.throws(()=>parseEventFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]>'+xml('bad'),feed,now));
  assert.throws(()=>parseEventFeed('<html>access denied</html>',feed,now));
  const sec={...feed,id:'sec',host:'sec.gov',name:'SEC EDGAR'};
  const atom=`<feed><entry><title>8-K - Apple Inc. (0000320193) (Filer)</title><updated>${new Date(now).toISOString()}</updated><link href="https://www.sec.gov/Archives/edgar/data/320193/index.html"/></entry></feed>`;
  const filing=parseEventFeed(atom,sec,now)[0];assert.equal(filing.cik,'0000320193');assert.equal(filing.form,'8-K');assert.equal(filing.issuer,'Apple Inc.');
});
test('users share in-flight feeds, polling cache and conditional GET; a closed-to-open transition restores fast cadence',async()=>{
  let clock=now,count=0,etag;const collector=createEventCollector({feeds:[feed],now:()=>clock,fetchImpl:async(_,options)=>{count++;etag=options.headers['if-none-match'];return count===1?new Response(xml('공시'),{headers:{etag:'"one"'}}):new Response(null,{status:304});}});
  await Promise.all([collector.collect('KR'),collector.collect('KR')]);assert.equal(count,1);
  clock+=59000;await collector.collect('KR');assert.equal(count,1);
  clock+=1000;const result=await collector.collect('KR',{closed:true});assert.equal(count,2);assert.equal(etag,'"one"');assert.equal(result.items.length,1);
  clock+=61000;await collector.collect('KR');assert.equal(count,3);
});
test('blocked and rate-limited feeds honor shared cooldowns; failed cached feeds cannot masquerade as fresh event evidence',async()=>{
  let clock=now,count=0;const collector=createEventCollector({feeds:[feed],now:()=>clock,fetchImpl:async()=>{count++;return count===1?new Response(xml('공시')):new Response('blocked',{status:403});}});
  await collector.collect('KR');clock+=60000;const blocked=await collector.collect('KR');assert.equal(blocked.sources[0].status,'blocked');assert.equal(blocked.items.length,0);
  clock+=120000;await collector.collect('KR');assert.equal(count,2);
  const rate=createEventCollector({feeds:[feed],now:()=>clock,fetchImpl:async()=>new Response('',{status:429,headers:{'retry-after':'900'}})});
  const limited=await rate.collect('KR');assert.equal(limited.sources[0].nextAttempt,clock+900000);assert.equal(limited.sources[0].status,'error');
});
test('official CIK/ticker mapping resolves non-English portfolio names without exposing full mapping to account views',async()=>{
  const sec={...feed,id:'sec',name:'SEC EDGAR',host:'sec.gov',markets:['US']},mapping={...sec,id:'sec-tickers',kind:'mapping',url:'https://www.sec.gov/files/company_tickers.json'};let clock=now;
  const collector=createEventCollector({feeds:[sec,mapping],now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async url=>String(url).includes('company_tickers')?Response.json({0:{cik_str:320193,ticker:'AAPL',title:'Apple Inc.'}}):new Response(`<feed><entry><title>8-K - Apple Inc. (0000320193) (Filer)</title><updated>${new Date(now).toISOString()}</updated><link href="https://www.sec.gov/Archives/edgar/data/320193/index.html"/></entry></feed>`)});
  const result=await collector.collect('US');assert.deepEqual(result.items[0].symbols,['AAPL']);assert.ok(result.sources.every(s=>!s.mappings));
});
test('first snapshot is a baseline; new adverse filings cancel pending buys once and dedup survives state serialization',()=>{
  const s=state();ingestEvents(s,snapshot([]),'KR',now);
  s.paperOrders.push({symbol:'005930',side:'BUY',status:'PENDING'});
  const events=ingestEvents(s,snapshot([item()]),'KR',now+60000);
  assert.equal(events.length,1);assert.equal(s.paperOrders[0].status,'CANCELED');assert.ok(s.eventWatch.blocks['005930']);assert.ok(s.eventWatch.pending);
  const restored=JSON.parse(JSON.stringify(s));assert.equal(ingestEvents(restored,snapshot([item()]),'KR',now+120000).length,0);
  assert.equal(restored.eventWatch.reactions.length,1);
  const fresh=state();assert.equal(ingestEvents(fresh,snapshot([item()]),'KR',now).length,0);assert.equal(fresh.eventWatch.pending,null);
});
test('generic filing forms and denied/uncertain headlines are not automatically good or bad earnings',()=>{
  assert.equal(classifyEvent(item('(유가)삼성전자 - 분기보고서')).direction,0);
  assert.equal(classifyEvent(item('Apple files for bankruptcy',{kind:'news'})).critical,false);
  assert.equal(classifyEvent(item('(유가)삼성전자 - 파산신청 사실무근')).direction,0);
  assert.equal(classifyEvent(item('Apple may cut guidance',{kind:'news'})).direction,0);
  assert.equal(classifyEvent(item('(유가)삼성전자 - 감사의견거절')).critical,true);
});
test('ordinary negative news needs price weakness to sell, while new buys pause; official critical filings still require an executable quote/book',()=>{
  const s=state();ingestEvents(s,snapshot([]),'KR',now);ingestEvents(s,snapshot([item()]),'KR',now+1000);
  const position={symbol:'005930',name:'삼성전자',entry:10000};
  assert.equal(eventExitReason(s,position,10000,10000,now+1000,'KR'),null);
  assert.match(eventExitReason(s,position,9900,10000,now+1000,'KR'),/장중/);
  assert.equal(eventSignal(s,position,now+1000).blocked,true);
  assert.equal(eventExitReason(s,position,9900,10000,now+31*60000,'KR'),null);
  const critical=state();ingestEvents(critical,snapshot([]),'KR',now);ingestEvents(critical,snapshot([item('(유가)삼성전자 - 감사의견거절')]),'KR',now+1000);
  critical.positions=[{...position,quantity:10,price:10000,quoteTime:now,costKrw:100000}];critical.cash-=100000;
  const result=execute(critical,{now:now+1000,regularStart:now-3600000,regularEnd:now+3600000,quotes:new Map([['005930',{price:10000,time:now+1000}]]),books:new Map(),candidates:[],monitor:true,openingExit:(p,price)=>eventExitReason(critical,p,price,10000,now+1000,'KR')});
  assert.equal(result.length,0);assert.equal(critical.paperOrders[0].status,'PENDING');assert.equal(critical.paperOrders[0].source,'event');
});
test('positive media claims need independent corroboration or an official disclosure; stale/error evidence cannot boost candidates',()=>{
  const s=state();const positive=item('(유가)삼성전자 - 실적 전망 상회',{source:'뉴스A',sourceId:'a',kind:'news'});s.eventWatch={sources:[source('a','뉴스A','news')],items:[positive],blocks:{}};
  const stock=s.universe.stocks[0];assert.equal(eventSignal(s,stock,now).relevant,false);
  s.eventWatch.sources.push(source('b','뉴스B','news'));s.eventWatch.items.push({...positive,source:'뉴스B',sourceId:'b'});assert.equal(eventSignal(s,stock,now).relevant,true);
  s.eventWatch.sources[1].status='error';assert.equal(eventSignal(s,stock,now).relevant,false);
  assert.equal(eventSignal(s,stock,now+21*60000).relevant,false);
});
test('unmatched companies, stale items and same-story duplicates do not retrigger trades; account states remain separate',()=>{
  const s=state();ingestEvents(s,snapshot([]),'KR',now);
  const other=item('(유가)다른회사 - 유상증자결정');assert.equal(ingestEvents(s,snapshot([other]),'KR',now+1000).length,0);
  assert.equal(ingestEvents(s,snapshot([item('old',{time:now-21*60000,fingerprint:'old'})]),'KR',now+1000).length,0);
  const isolated=state();assert.equal(isolated.eventWatch,undefined);assert.equal(eventsView(s,now).status,'ok');
});
test('material market-wide headlines trigger bounded reevaluation even without a single-company ticker match',()=>{
  const s=state(),src=source('cnbc','CNBC','news');
  ingestEvents(s,{checkedAt:now,sources:[src],items:[]},'KR',now);
  const headline=item('U.S. imposes new tariffs on chipmakers',{source:'CNBC',sourceId:'cnbc',issuer:null,kind:'news',fingerprint:'new-tariffs'});
  const fresh=ingestEvents(s,{checkedAt:now+1000,sources:[src],items:[headline]},'KR',now+1000);
  assert.equal(fresh.length,1);assert.ok(s.eventWatch.pending);assert.deepEqual(s.eventWatch.pending.symbols,[]);
  assert.equal(s.trades.length,0);
});
test('server monitor reacts to a new filing before the next ten-minute slot, records event fills, reanalyses once and preserves the regular reference',async t=>{
  let clock=now;const started=performance.now();t.mock.method(Date,'now',()=>clock+Math.floor(performance.now()-started));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const file of ['0000_campaign.sql','0001_us_campaign.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  const env={MARKETLAB_KEY:'01'.repeat(32),MARKETLAB_BATCH:true,DB:{prepare(sql){const statement=db.prepare(sql);const bind=(...p)=>({first:async()=>statement.get(...p)??null,run:async()=>({meta:{changes:statement.run(...p).changes}})});return{...bind(),bind};}},collectEvents:async market=>market==='KR'?snapshot([item()]):snapshot([])};
  const s=state();s.cash-=100000;s.positions.push({symbol:'005930',name:'삼성전자',type:'주식',entry:10000,entryPrice:10000,price:10000,quantity:10,quoteTime:now,costKrw:100000});
  s.previous={date:'2026-11-26',time:now-600000,prices:{'005930':10000}};const previous=structuredClone(s.previous);
  ingestEvents(s,snapshot([]),'KR',now-60000);
  const key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(1),'AES-GCM',false,['encrypt']);const iv=new Uint8Array(12);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('toss:token')},key,new TextEncoder().encode(JSON.stringify({value:'fake-events-test-token',expires:now+24*3600000})));
  const token=Buffer.from(iv).toString('base64')+'.'+Buffer.from(cipher).toString('base64');
  db.prepare('INSERT INTO campaign(id,state,secrets,access_token) VALUES(1,?,?,?)').run(JSON.stringify(s),'unused-test-credentials',token);
  let realOrders=0;
  t.mock.method(globalThis,'fetch',async(input,options={})=>{
    const url=new URL(input);assert.equal(url.hostname,'openapi.tossinvest.com');assert.equal(options.method,'GET');
    const route=url.pathname.replace('/api/v1/',''),timestamp=new Date(Date.now()).toISOString();let result;
    if(/orders/.test(route)){realOrders++;throw Error('No live orders');}
    if(route==='market-calendar/KR')result={today:{date:'2026-11-26',integrated:{regularMarket:{startTime:'2026-11-26T09:00:00+09:00',singlePriceAuctionStartTime:'2026-11-26T15:20:00+09:00',endTime:'2026-11-26T15:30:00+09:00'}}}};
    else if(route==='market-calendar/US')result={today:{date:'2026-11-25',regularMarket:{startTime:'2026-11-25T14:30:00Z',endTime:'2026-11-25T21:00:00Z'}}};
    else if(route==='prices')result=url.searchParams.get('symbols').split(',').map(symbol=>({symbol,currency:'KRW',lastPrice:'9900',timestamp}));
    else if(route==='orderbook')result={currency:'KRW',timestamp,asks:[{price:'9905',volume:'1000'}],bids:[{price:'9895',volume:'1000'}]};
    else if(route==='rankings')result={rankedAt:timestamp,rankings:[]};
    else if(route==='market-indicators/prices')result=[{symbol:'KOSPI',lastPrice:'3000',timestamp}];
    else if(route==='market-indicators/KOSPI/candles')result={candles:[{timestamp:'2026-11-25T00:00:00Z',closePrice:'3000'}]};
    else if(route==='market-indicators/KOSPI/investor-trading')result={records:[]};
    else if(route==='exchange-rate')result={baseCurrency:'USD',quoteCurrency:'KRW',midRate:'1400',validFrom:timestamp,validUntil:new Date(Date.now()+60000).toISOString()};
    else throw Error('Unexpected read '+route);
    return Response.json({result});
  });
  await runMonitor(env,Date.now());
  let saved=JSON.parse(db.prepare('SELECT state FROM campaign WHERE id=1').get().state);
  assert.equal(saved.trades.length,1);assert.equal(saved.trades[0].source,'event');assert.equal(saved.trades[0].side,'SELL');assert.match(saved.trades[0].reason,/장중/);
  assert.equal(saved.positions.length,0);assert.equal(saved.eventWatch.pending,null);assert.deepEqual(saved.previous,previous);
  assert.equal(saved.scans.filter(s=>s.source==='event').length,1);
  clock+=60000;await runMonitor(env,Date.now());saved=JSON.parse(db.prepare('SELECT state FROM campaign WHERE id=1').get().state);
  assert.equal(saved.trades.length,1);assert.equal(saved.scans.filter(s=>s.source==='event').length,1);assert.equal(realOrders,0);
  const response=await app.fetch(new Request('http://localhost/api/state',{headers:{'oai-authenticated-user-id':'test'}}),env);
  const view=await response.json();assert.ok(view.eventWatch.sources.length);assert.equal(view.eventWatch.reactions.length,1);assert.ok(!JSON.stringify(view).includes('fake-events-test-token'));
  clock=Date.parse('2026-11-26T15:31:30+09:00');await runMonitor(env,Date.now());
  const reviewResponse=await app.fetch(new Request('http://localhost/api/reviews?date=2026-11-26',{headers:{'oai-authenticated-user-id':'test'}}),env);
  const review=await reviewResponse.json();assert.equal(review.report.status,'final');assert.equal(review.report.decisions.length,1);assert.ok(review.report.quality.some(v=>v.includes('마감 시세')));
});
