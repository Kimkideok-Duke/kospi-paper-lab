import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initialState} from '../server/engine.mjs';
import {initialUsState} from '../server/us-engine.mjs';
import {upgradePaper} from '../server/paper-model.mjs';
import {marketDate,activateDailyPolicy,strategyPolicy} from '../server/strategy-policy.mjs';
import {syncDailyReviews,reviewCalendar,recordReviewEvidence,reviewSymbols} from '../server/daily-review.mjs';
import {scanUs} from '../server/us-paper.mjs';
const at=text=>Date.parse(text),date='2026-11-25',start=at(date+'T09:00:00+09:00'),end=at(date+'T15:30:00+09:00');
function state(market='KR',day=date,early=false){const s=upgradePaper(market==='US'?initialUsState():initialState(),market,start);
  s.calendar={date:day,result:{today:market==='KR'?{date:day,integrated:{regularMarket:{startTime:day+'T09:00:00+09:00',endTime:day+'T15:30:00+09:00'}}}:{date:day,regularMarket:{startTime:day+'T14:30:00Z',endTime:day+(early?'T18:00:00Z':'T21:00:00Z')}}}};return s;}
function fill(id,side,time,extra={}){return{id:String(id),symbol:'005930',name:'삼성전자',side,time,price:10000,quantity:1,amount:10000,realized:side==='SELL'?-100:0,reason:side==='SELL'?'단기 추세 약화':'최근 분봉 상승 확인',costs:{commission:2,transactionTax:0,fxSpread:0,slippage:0},...extra};}
test('KR reviews wait for actual full-session close plus grace; immutable reports preserve original trades and separate PnL concepts',()=>{
  const s=state();s.trades=[fill(1,'BUY',start+600000),fill(2,'SELL',start+1200000)];s.daily=[{date,open:10000000,close:10000200,time:end}];
  const before=structuredClone(s.trades);syncDailyReviews(s,'KR',end-1);assert.equal(Object.keys(s.reviews).length,0);
  syncDailyReviews(s,'KR',end+30000);assert.equal(Object.keys(s.reviews).length,0);
  syncDailyReviews(s,'KR',end+60000);const report=s.reviews[date];assert.equal(report.summary.equityPnl,200);assert.equal(report.summary.realized,-100);assert.equal(report.summary.explicitCosts,4);
  assert.equal(report.decisions[0].reason,s.trades[0].reason);assert.equal(report.adaptive.changed,false);assert.ok(report.quality.some(v=>v.includes('시세 경로')));
  s.daily[0].close=9999000;syncDailyReviews(s,'KR',end+120000);assert.equal(s.reviews[date],report);assert.deepEqual(s.trades,before);
});
test('US reviews follow New York date and exchange-provided early close, not Korean midnight or a fixed 16:00 assumption',()=>{
  const s=state('US','2026-11-27',true),close=at('2026-11-27T18:00:00Z');s.trades=[fill(1,'BUY',at('2026-11-27T15:00:00Z'),{symbol:'AAPL',priceUsd:100,fxRate:1400})];
  s.daily=[{date:'2026-11-27',open:10000000,close:10000000,time:close}];
  assert.equal(marketDate(at('2026-11-27T16:00:00Z'),'US'),'2026-11-27');
  syncDailyReviews(s,'US',close-1);assert.equal(s.reviews['2026-11-27'],undefined);
  syncDailyReviews(s,'US',close+60000);assert.equal(s.reviews['2026-11-27'].sessionEnd,close);
});
test('counterfactuals use only recorded 5-to-7-minute later quotes with fixed execution FX and disclose unmodelled costs/fills',()=>{
  const s=state('US'),time=at(date+'T15:00:00Z');s.trades=[fill(1,'BUY',time,{symbol:'AAPL',priceUsd:100,fxRate:1400,quantity:2})];
  recordReviewEvidence(s,'US',new Map([['AAPL',{price:98,time:time+5*60000}]]),{rate:1500},time+5*60000);
  syncDailyReviews(s,'US',at(date+'T21:01:00Z'));const alternative=s.reviews[date].decisions[0].alternative;
  assert.equal(alternative.grossDifferenceKrw,5600);assert.match(alternative.text,/사후 비교/);assert.match(alternative.text,/비용/);
  assert.deepEqual(reviewSymbols(s,'US',time),['AAPL']);
});
test('sold symbols remain observed; minute snapshots deduplicate, reject stale/after-hours quotes and bound retained evidence',()=>{
  const s=state();s.trades=[fill(1,'SELL',start+600000)];const time=start+900000;
  recordReviewEvidence(s,'KR',new Map([['005930',{price:10100,time}]]),{rate:1},time);
  recordReviewEvidence(s,'KR',new Map([['005930',{price:10101,time:time+1000}]]),{rate:1},time+1000);
  assert.equal(s.reviewEvidence[date].points.length,1);assert.equal(s.reviewEvidence[date].points[0].price,10101);
  recordReviewEvidence(s,'KR',new Map([['005930',{price:20000,time:end+60000}]]),{rate:1},end+60000);
  assert.equal(s.reviewEvidence[date].points.length,1);
});
function losingHistory(s){for(let d=0;d<2;d++)for(let i=0;i<3;i++){const time=at((d?'2026-11-26':'2026-11-25')+'T10:00:00+09:00')+i*600000;const id=s.trades.length+1;s.trades.push(fill(id,'BUY',time,{symbol:'T'+i}),fill(id+1,'SELL',time+60000,{symbol:'T'+i,realized:-200}));}}
test('daily learning schedules bounded real entry-rule changes only with completed multi-day evidence, not partial-fill counts',()=>{
  const s=state('KR','2026-11-26');losingHistory(s);s.daily=[{date:'2026-11-25',open:10000000,close:9999400,time:end},{date:'2026-11-26',open:9999400,close:9998800,time:at('2026-11-26T15:30:00+09:00')}];
  syncDailyReviews(s,'KR',at('2026-11-26T15:32:00+09:00'));
  const report=s.reviews['2026-11-26'];assert.equal(report.adaptive.sample.completedTrips,6);assert.equal(report.adaptive.after.minimumMomentumPct,.2);assert.equal(report.adaptive.changed,true);
  assert.equal(strategyPolicy(s).minimumMomentumPct,.15);assert.equal(s.dailyPolicy.pending.sourceDate,'2026-11-26');
  const partial=state();partial.trades=[fill(1,'BUY',start,{quantity:10}),...Array.from({length:10},(_,i)=>fill(i+2,'SELL',start+(i+1)*60000,{quantity:1,realized:-10}))];
  syncDailyReviews(partial,'KR',end+60000);assert.equal(partial.reviews[date].adaptive.sample.completedTrips,1);assert.equal(partial.reviews[date].adaptive.changed,false);
});
test('strategy changes activate once at the next verified trading session and preserve cash, fills, cost assumptions and risk limits',()=>{
  const s=state('KR','2026-11-26');losingHistory(s);syncDailyReviews(s,'KR',at('2026-11-26T15:32:00+09:00'));
  const before=structuredClone({cash:s.cash,trades:s.trades,config:s.paperModel.config}),versions=s.versions.length;
  assert.equal(activateDailyPolicy(s,'KR',at('2026-11-26T16:00:00+09:00')),false);
  assert.equal(activateDailyPolicy(s,'KR',at('2026-11-27T09:00:00+09:00')),false);
  s.calendar=state('KR','2026-11-27').calendar;
  assert.equal(activateDailyPolicy(s,'KR',at('2026-11-27T09:00:00+09:00')),true);assert.equal(strategyPolicy(s).minimumMomentumPct,.2);
  assert.equal(activateDailyPolicy(s,'KR',at('2026-11-27T09:01:00+09:00')),false);assert.equal(s.versions.length,versions+1);
  assert.deepEqual({cash:s.cash,trades:s.trades,config:s.paperModel.config},before);assert.equal(s.dailyPolicy.pending,null);
});
test('actual US candidate evaluation uses the learned threshold, rather than merely displaying a changed policy',async t=>{
  const time=at(date+'T15:00:00Z');t.mock.method(Date,'now',()=>time);
  const make=threshold=>{const s=state('US');s.dailyPolicy={current:{minimumMomentumPct:threshold,maximumSpreadPct:.65}};s.universe={date,stocks:[{symbol:'AAPL',name:'애플',type:'주식',marketCountry:'US'}]};s.previous={date,index:2,prices:{AAPL:100}};return s;};
  const client={missing:new Set(),async get(path){if(path==='prices')return ['AAPL','SPY','QQQ'].map(symbol=>({symbol,currency:'USD',lastPrice:'100.3',timestamp:new Date(time).toISOString()}));if(path==='rankings')return{rankedAt:new Date(time).toISOString(),rankings:[{symbol:'AAPL',currency:'USD',price:{basePrice:'100'},tradingAmount:'100000000'}]};if(path==='exchange-rate')return{baseCurrency:'USD',quoteCurrency:'KRW',midRate:'1400',validFrom:new Date(time-1000).toISOString(),validUntil:new Date(time+60000).toISOString()};if(path==='candles')return{candles:[100.3,100.15,100].map((price,i)=>({currency:'USD',timestamp:new Date(time-i*60000).toISOString(),closePrice:String(price),volume:'10000'}))};if(path==='orderbook')return{currency:'USD',timestamp:new Date(time).toISOString(),asks:[{price:'100.31',volume:'10000'}],bids:[{price:'100.30',volume:'10000'}]};if(path.endsWith('/warnings'))return[];throw Error(path);}};
  const slot={market:'US',date,index:3,regularStart:at(date+'T14:30:00Z'),regularEnd:at(date+'T21:00:00Z')},normal=make(.15),strict=make(.4);
  assert.equal((await scanUs(normal,slot,client,normal.calendar.result)).trades.length,0);
  assert.equal(normal.paperOrders.length,1); assert.equal(normal.paperOrders[0].executionStyle,"RESTING_ENTRY");
  assert.equal((await scanUs(strict,slot,client,strict.calendar.result)).trades.length,0);
  assert.equal(strict.paperOrders.length,0);
});
