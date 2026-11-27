import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectDayCharts,dayChartAnalysis} from '../server/day-chart-review.mjs';
import {stockReview} from '../server/stock-review.mjs';
import {reviewCalendar} from '../server/daily-review.mjs';
const date='2026-11-26',at=t=>Date.parse(date+'T'+t+':00+09:00'),start=at('09:00'),end=at('15:30');
const c=(time,close=100,extra={})=>({timestamp:new Date(time).toISOString(),currency:'KRW',openPrice:String(close),highPrice:String(close+1),lowPrice:String(close-1),closePrice:String(close),volume:'100',...extra});
const fill={id:'1',symbol:'A',name:'테스트',time:at('10:00')+30000,side:'SELL',quantity:2,price:100,reason:'손절 기준',realized:-4};
function fixture(n=1){return {trades:Array.from({length:n},(_,i)=>({...fill,id:String(i+1),symbol:'T'+i})),cash:1000,positions:[],history:[],daily:[],scans:[],reviews:{[date]:{date,market:'KR',summary:{},quality:[],decisions:[fill],method:'원래 복기',adaptive:{changed:false}}},reviewSessions:{[date]:{start,end}},dailyPolicy:{current:{minimumMomentumPct:.15},pending:{sourceDate:date}}};}

test('post-close all traded symbols are collected incrementally with a request budget, native completed minute bars and immutable original reports/ledger',async()=>{
 const s=fixture(35),before=structuredClone(s),client={async get(path,p){assert.equal(path,'candles');assert.equal(p.interval,'1m');assert.equal(p.adjusted,false);assert.equal(Date.parse(p.before),end);return {candles:[c(end),c(start+60000),c(start),c(end+60000)],nextBefore:null};}};const scope={};
 assert.equal((await collectDayCharts(s,'KR',client,scope,end+59000)).requests,0);
 for(let i=0;i<18;i++){const r=await collectDayCharts(s,'KR',client,scope,end+60000+i*60000,{budget:2,maxSymbols:2});assert.ok(r.requests<=2);}
 const a=s.reviewDayCharts[date];assert.equal(a.status,'complete');assert.equal(a.confirmed,35);assert.equal(a.records.T0.candles.length,2);
 assert.equal((await collectDayCharts(s,'KR',client,scope,end+3600000)).requests,0);
 for(const key of ['cash','positions','trades','reviews','dailyPolicy'])assert.deepEqual(s[key],before[key]);
});

test('failed or invalid data remains retryable, budget and pagination failures cannot claim success and later retry fills missing evidence',async()=>{
 const s=fixture(),scope={};let ok=false;
 const client={async get(path,p){if(!ok)throw Error('offline');return {candles:[c(end),c(start+60000)],nextBefore:null};}};
 await collectDayCharts(s,'KR',client,scope,end+60000);assert.equal(s.reviewDayCharts[date].records.T0.status,'retry');assert.equal(s.reviewDayCharts[date].status,'partial');
 assert.equal((await collectDayCharts(s,'KR',client,scope,end+61000)).requests,0);
 ok=true;await collectDayCharts(s,'KR',client,scope,end+121000);assert.equal(s.reviewDayCharts[date].status,'complete');
 const bad=fixture();await collectDayCharts(bad,'KR',{async get(){return{candles:[c(end,100,{currency:'USD'})],nextBefore:null};}},{},end+60000);assert.notEqual(bad.reviewDayCharts[date].status,'complete');
});

test('US historical New York date and early close are read from calendar; no preclose, next-day or after-hours bars enter the review',async()=>{
 const date='2026-11-27',start=Date.parse(date+'T14:30:00Z'),end=Date.parse(date+'T18:00:00Z');
 const s={trades:[{...fill,symbol:'A',time:Date.parse(date+'T15:00:00Z')}],reviews:{},reviewSessions:{}};const calls=[];
 const client={async get(path,p){calls.push(path);if(path==='market-calendar/US')return{today:{date,regularMarket:{startTime:new Date(start).toISOString(),endTime:new Date(end).toISOString()}}};return{candles:[c(end,100,{currency:'USD'}),c(end+60000,200,{currency:'USD'}),c(start+60000,99,{currency:'USD'})],nextBefore:null};}};
 await collectDayCharts(s,'US',client,{},end+60000);assert.equal(s.reviewDayCharts[date].session.end,end);assert.equal(s.reviewDayCharts[date].records.A.candles.length,2);assert.equal(calls[0],'market-calendar/US');
});

test('minute END semantics exclude a fill-straddling bar; 5/15/30-minute prices, post-sale extrema, FX and last bar are labelled retrospective, not executable gains',()=>{
 const time=fill.time,record={status:'confirmed',start,end,checkedAt:end+60000,candles:[
 {time:at('10:01'),open:100,high:9999,low:1,close:100,volume:1},
 ...[2,6,16,31].map((m,i)=>({time:at('10:00')+m*60000,open:101+i,high:102+i,low:100+i,close:101+i,volume:1})),
 {time:end,open:109,high:111,low:108,close:110,volume:10}]};
 const a=dayChartAnalysis([fill],record,'KR',[fill]).analyses[0];assert.equal(a.high.price,111);assert.equal(a.low.price,100);assert.equal(a.checkpoints[0].price,102);assert.equal(a.checkpoints[1].price,103);assert.equal(a.checkpoints[2].price,104);assert.equal(a.last.differenceKrw,20);assert.match(a.suggestion,/위험|보호/);
 const us=dayChartAnalysis([fill],record,'US',[{...fill,priceUsd:100,fxRate:1400}]);assert.equal(us.analyses[0].last.differenceKrw,28000);
 const missing=dayChartAnalysis([fill],record,'US',[]);assert.equal(missing.analyses[0].last.differenceKrw,null);
 const late=dayChartAnalysis([{...fill,time:end-10000}],record,'KR',[]).analyses[0];assert.equal(late.last,null);assert.match(late.judgement,/마감 직전/);
});

test('a report without old post-fill observations receives a chart supplement and cache revision, with no rewrite of trades, policy or report',async()=>{
 const s=fixture(),before=structuredClone(s);s.trades=[fill];
 await collectDayCharts(s,'KR',{async get(){return{candles:[c(end,110),c(at('10:06'),101)],nextBefore:null};}},{},end+60000);
 const view=stockReview(s.reviews[date],s.reviewDayCharts[date],s.trades);
 assert.ok(view.stocks[0].improvements.some(x=>x.includes('보완했습니다')));assert.equal(view.stocks[0].dayChart.analyses[0].last.price,110);assert.match(view.alternatives,/마감 후/);assert.equal(view.dayChartReview.confirmed,1);
 assert.match(reviewCalendar(s,'KR',end+60000).days[0].closingRevision,/:chart:complete:/);
 assert.deepEqual(s.reviews,before.reviews);assert.deepEqual(s.dailyPolicy,before.dailyPolicy);assert.deepEqual(s.trades,[fill]);
});
