import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchBook,researchSpread,validateArchive} from '../research/evidence.mjs';
import {replay,qualification,searchArchive} from '../research/replay.mjs';
import {auditPages} from '../research/audit-candles.mjs';

function fixture(){
 const time=Date.parse('2026-05-04T10:00:00+09:00');
 const row={symbol:'TEST',name:'테스트',type:'STOCK',date:'2026-05-04',time,availableAt:time,price:10000,
  regularStart:time-3600000,regularEnd:time+3600000,previousPrices:{},previousAvailableAt:time,
  candidate:{eligible:true,signalTime:time,momentum:1,reason:'합성 검증 자료'},
  coverage:{news:'complete',disclosures:'complete',universe:'point-in-time',from:time-60000,until:time},
  book:{time,asks:[{price:10050,volume:10000},{price:10000,volume:10000}],bids:[{price:9970,volume:10000},{price:9990,volume:10000}]}};
 return {market:'KR',start:'2026-05-01',sessionDates:['2026-05-04'],snapshots:[row],events:[]};
}
test('research uses best executable prices independently of source level order and preserves raw inputs',()=>{
 const archive=fixture(),raw=structuredClone(archive);
 const result=replay(archive,{momentum:.15,spread:.2,pattern:false},{from:'2026-05-01',until:'2026-05-31'});
 assert.equal(result.decisions[0].eligible,true);assert.deepEqual(archive,raw);
 const book=researchBook(archive.snapshots[0].book);assert.equal(book.asks[0].price,10000);assert.equal(book.bids[0].price,9990);
 assert.equal(researchSpread({...book,asks:[{price:9990,volume:0}]}),null);
 assert.equal(researchSpread({...book,asks:[{price:9980,volume:10}]}),null);
});
test('invalid price, quantity and duplicated depth block replay rather than generating a zero-return experiment',()=>{
 for(const bad of [{price:'bad',volume:1},{price:Infinity,volume:1},{price:true,volume:1},{price:10000,volume:-1},{price:10000,volume:' '},{price:10000,volume:.5}]){
  const archive=fixture();archive.snapshots[0].book.asks=[bad];assert.ok(validateArchive(archive).length);assert.equal(replay(archive,{momentum:.15,spread:.2,pattern:false},{from:'2026-05-01',until:'2026-05-31'}).status,'blocked');
 }
 const archive=fixture();archive.snapshots[0].book.bids.push({...archive.snapshots[0].book.bids[0]});assert.ok(validateArchive(archive).length);
 archive.snapshots[0].previousPrices=null;assert.ok(validateArchive(archive).includes('직전 분석 가격 자료 누락'));
});
const metric=(overrides={})=>({status:'complete',returnPct:1,maxDrawdownPct:1,explicitCosts:100,slippage:10,completedTrips:5,completedDays:2,sellOrders:5,...overrides});
test('candidate qualification requires completed round trips on multiple days, not partial sell orders',()=>{
 const reference={validation:metric()},trial={train:metric(),validation:metric({returnPct:2,completedTrips:0,sellOrders:100})};
 assert.equal(qualification(trial,reference).qualified,false);
 trial.validation=metric({returnPct:2,completedDays:1});assert.equal(qualification(trial,reference).qualified,false);
 trial.validation=metric({returnPct:2});assert.equal(qualification(trial,reference).qualified,true);
});
test('candidate selection rejects worsened baseline return, drawdown, fees, slippage and missing metrics',()=>{
 const reference={validation:metric()};
 for(const changes of [{returnPct:1},{returnPct:2,maxDrawdownPct:1.1},{returnPct:2,explicitCosts:101},{returnPct:2,slippage:11},{returnPct:2,slippage:NaN}])assert.equal(qualification({train:metric(),validation:metric(changes)},reference).qualified,false);
 const archive=fixture(),result=searchArchive(archive,'2026-11-27');assert.equal(result.trials.length,18);assert.equal(result.candidate,null);assert.equal(result.status,'blocked');assert.equal(result.reference.validation.status,'blocked');assert.equal(result.reference.validation.returnPct,undefined);assert.equal(result.promote,false);
 const custom=searchArchive(archive,'2026-11-27',{referenceParameters:{momentum:.18,spread:.2,pattern:false}});assert.equal(custom.reference.parameters.momentum,.18);assert.equal(custom.trials.length,18);
});
test('replay reports completed cycles across sessions and cash costs separately from price slippage',()=>{
 const archive=fixture(),base=archive.snapshots[0];
 archive.sessionDates=['2026-05-04','2026-05-06'];archive.snapshots=[];
 for(const date of archive.sessionDates){
  const time=Date.parse(date+'T10:00:00+09:00');
  for(const exit of [false,true]){
   const at=time+(exit?60000:0),price=exit?10700:10000;
   archive.snapshots.push({...structuredClone(base),date,time:at,availableAt:at,price,regularStart:time-3600000,regularEnd:time+3600000,previousAvailableAt:at,
    candidate:{...base.candidate,eligible:!exit,signalTime:at},coverage:{...base.coverage,from:time-60000,until:at},
    book:{time:at,asks:[{price:exit?10691:9970,volume:10000}],bids:[{price:exit?10690:9969,volume:10000}]}});
  }
 }
 const r=replay(archive,{momentum:.15,spread:.2,pattern:false},{from:'2026-05-01',until:'2026-05-31'});
 assert.equal(r.completedTrips,2);assert.equal(r.completedDays,2);assert.equal(r.sellOrders,2);assert.equal(r.fills,4);assert.ok(r.explicitCosts>0);assert.ok(Number.isFinite(r.slippage));assert.ok(r.slippage<0);assert.ok(r.returnPct>0); // Signed slippage includes favorable fills.
});
test('candle page audit deduplicates inclusive boundaries and detects conflicting prices without declaring universe completeness',()=>{
 const stamp=Date.parse('2026-05-04T10:00:00+09:00');
 const candle=t=>({timestamp:new Date(t).toISOString(),openPrice:'100',highPrice:'101',lowPrice:'99',closePrice:'100',volume:'10',currency:'KRW'});
 const pages=[{before:new Date(stamp).toISOString(),nextBefore:new Date(stamp-60000).toISOString(),candles:[candle(stamp),candle(stamp-60000)]},
  {before:new Date(stamp-60000).toISOString(),nextBefore:null,candles:[candle(stamp-60000),candle(stamp-120000)]}];
 const options={from:stamp-3600000,until:stamp,expectedDates:['2026-05-04','2026-05-06'],complete:true};
 const result=auditPages(pages,options);assert.equal(result.status,'checked');assert.equal(result.uniqueBars,3);assert.equal(result.boundaryDuplicates,1);assert.deepEqual(result.unobservedDates,['2026-05-06']);assert.equal(result.pointInTimeUniverseVerified,false);
 pages[1].candles[0].closePrice='101';assert.equal(auditPages(pages,options).status,'invalid');assert.equal(auditPages(pages,options).conflicts,1);
 pages[1].before=pages[0].before;assert.ok(auditPages(pages,options).errors.includes('broken-page-chain'));
});
