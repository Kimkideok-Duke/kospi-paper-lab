import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradeChart, recordTradeCharts } from '../server/trade-chart.mjs';
const start = Date.parse('2026-11-26T11:00:00+09:00');
const buy = (id,time=start,extra={}) => ({id:String(id),symbol:'TEST',name:'테스트 종목',time,side:'BUY',quantity:10,price:100,priceUsd:10,fxRate:1400,reason:'상승 확인',...extra});
const sell = (id,time=start+600000,extra={}) => ({...buy(id,time),side:'SELL',realized:1000,price:110,priceUsd:11,reason:'익절',...extra});

test('daily review chart includes every round trip in the local market day and excludes other symbols and dates',()=>{
  const time=Date.parse('2026-11-26T01:00:00Z'); // US November 25, Korean November 26
  const s={trades:[buy(1,time),sell(2,time+60000),buy(3,time+120000),sell(4,time+180000),buy(5,time+86400000),buy(6,time,{symbol:'OTHER'})],
    tradeCharts:{1:{symbol:'TEST',points:[{time,price:10}]},3:{symbol:'TEST',points:[{time:time+120000,price:11}]},x:{symbol:'OTHER',points:[{time,price:999}]}}};
  const before=structuredClone(s),r=tradeChart(s,'US','3',time+86400000,'2026-11-25');
  assert.deepEqual(r.trades.map(t=>t.id),['1','2','3','4']);assert.deepEqual(r.trades.map(t=>t.reason),['상승 확인','익절','상승 확인','익절']);assert.equal(r.date,'2026-11-25');assert.equal(r.points.length,2);
  assert.equal(tradeChart(s,'US','3',time+86400000,'2026-11-26'),null);assert.deepEqual(s,before);
});
test('a selected partial fill retrieves its own round trip, with actual USD prices and trade markers separate from quotes',()=>{
  const s={trades:[buy(1),sell(2,start+300000,{quantity:4}),sell(3,start+600000,{quantity:6}),buy(4,start+3600000)],reviewEvidence:{day:{points:[{symbol:'TEST',time:start-60000,price:9.9},{symbol:'OTHER',time:start,price:999},{symbol:'TEST',time:start+60000,price:10.2}]}}};
  const before=structuredClone(s),r=tradeChart(s,'US','2',start+7200000);
  assert.equal(r.selectedId,'2');assert.equal(r.currency,'USD');assert.equal(r.open,false);assert.deepEqual(r.trades.map(t=>t.id),['1','2','3']);assert.equal(r.trades[0].price,10);assert.equal(r.trades[1].price,11);
  assert.equal(r.points.length,2);assert.ok(!r.points.some(p=>p.price===999));assert.deepEqual(s,before);
  assert.equal(tradeChart(s,'KR','4',start+7200000).open,true);assert.equal(tradeChart(s,'KR','absent'),null);
});
test('missing paths and missing USD fill prices remain unknown rather than inventing lines or using won prices',()=>{
  const r=tradeChart({trades:[sell(1,start,{priceUsd:undefined})]},'US','1',start);
  assert.equal(r.points.length,0);assert.equal(r.trades[0].price,null);assert.match(r.note,/부족/);assert.equal(r.open,null);
});

test('five-second observations within one minute keep separate timestamps without duplicating unchanged quote times',()=>{
  const state={trades:[buy(1)]};
  for(const offset of [0,1000,5000,10000,10000,15000])recordTradeCharts(state,'KR',new Map([['TEST',{time:start+offset,price:100+offset/1000}]]),start+offset);
  assert.deepEqual(state.tradeCharts['1'].points.map(p=>p.time-start),[1000,5000,10000,15000]);
  assert.ok(state.tradeCharts['1'].points.every(p=>p.source==='monitor-5s'));
});
test('chart observations persist after review eviction, deduplicate five-second buckets and stop collecting a closed trade after 30 minutes',()=>{
  const s={trades:[buy(1),sell(2)]},before=structuredClone(s.trades);
  for(const offset of [0,1000,60000,360000])recordTradeCharts(s,'KR',new Map([['TEST',{price:100+offset/60000,time:start+offset}]]),start+offset);
  const saved=s.tradeCharts['1'];assert.equal(saved.points.length,3);assert.equal(saved.points[0].time,start+1000);
  recordTradeCharts(s,'KR',new Map([['TEST',{price:1,time:start+41*60000}]]),start+41*60000);
  assert.equal(saved.points.length,3);assert.deepEqual(s.trades,before);
  const r=tradeChart(s,'KR','1',start+45*60000);assert.equal(r.points.length,3);assert.equal(r.gaps,1);
});
test('future, stale, pre-entry and invalid quotes are never retained; long paths are bounded and explicitly sampled',()=>{
  const s={trades:[buy(1)]};
  for(const q of [{price:100,time:start+1},{price:100,time:start-1},{price:NaN,time:start}])recordTradeCharts(s,'KR',new Map([['TEST',q]]),start);
  assert.equal(s.tradeCharts,undefined);
  const points=Array.from({length:40000},(_,i)=>({time:start+i*60000,price:100}));s.tradeCharts={'1':{symbol:'TEST',points,sampled:false}};
  const now=start+40000*60000;recordTradeCharts(s,'KR',new Map([['TEST',{price:101,time:now}]]),now);
  assert.ok(s.tradeCharts['1'].points.length<40000);assert.equal(s.tradeCharts['1'].sampled,true);assert.equal(s.tradeCharts['1'].points[0].time,start);assert.equal(s.tradeCharts['1'].points.at(-1).time,now);
});
