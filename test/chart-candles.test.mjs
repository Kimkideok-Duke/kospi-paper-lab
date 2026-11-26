import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chartRange,createChartCandleLoader,normalizeCandle} from '../server/chart-candles.mjs';
const time=Date.parse('2026-11-26T10:00:00+09:00');
const chart={market:'KR',symbol:'TEST',currency:'KRW',date:'2026-11-26',trades:[{time}],open:null};
const candle=(timestamp,extra={})=>({timestamp:new Date(timestamp).toISOString(),currency:'KRW',openPrice:'100',highPrice:'110',lowPrice:'90',closePrice:'105',volume:'0',...extra});

test('minute candles follow provider nextBefore, deduplicate boundaries, validate currency/OHLC and retain zero-volume bars',async()=>{
  const load=createChartCandleLoader(),scope={},calls=[];
  const client={async get(path,params){calls.push(params);assert.equal(path,'candles');return calls.length===1?{candles:[candle(time),candle(time-60000)],nextBefore:new Date(time-60000).toISOString()}:{candles:[candle(time-60000),candle(time-120000),candle(time-180000,{currency:'USD'})],nextBefore:null};}};
  const result=await load(scope,client,chart,time);assert.equal(result.candles.length,3);assert.equal(result.candles[0].time,time-120000);assert.equal(result.status,'partial');assert.equal(result.invalid,1);
  assert.equal(calls[1].before,new Date(time-60000).toISOString());assert.ok(calls.every(p=>p.count===200&&p.adjusted===false&&p.interval==='1m'));assert.equal(result.candles[0].volume,0);
  assert.equal(normalizeCandle(candle(time,{highPrice:'99'}),'KRW'),null);
  assert.equal(normalizeCandle(candle(time,{volume:null}),'KRW'),null);
});

test('tenant cache shares concurrent work, expires, isolates callers and returns defensive copies',async()=>{
  const load=createChartCandleLoader(),scope={},other={};let calls=0;
  const client={async get(){calls++;await Promise.resolve();return {candles:[candle(time)],nextBefore:null};}};
  const [a,b]=await Promise.all([load(scope,client,chart,time),load(scope,client,chart,time)]);assert.equal(calls,1);a.candles[0].close=999;assert.equal(b.candles[0].close,105);
  await load(other,client,chart,time);assert.equal(calls,2);await load(scope,client,chart,time+59000);assert.equal(calls,2);await load(scope,client,chart,time+61000);assert.equal(calls,3);
});

test('API failures and stalled pagination remain explicit; future bars are excluded',async()=>{
  const load=createChartCandleLoader(),scope={};let calls=0;
  const client={async get(path,p){calls++;if(calls===1)return {candles:[candle(time+60000),candle(time)],nextBefore:new Date(time-60000).toISOString()};throw Error('offline');}};
  const r=await load(scope,client,chart,time);assert.equal(r.status,'unavailable');assert.equal(r.candles.length,1);
  const stalled=await load({}, {async get(path,p){return{candles:[candle(time)],nextBefore:p.before};}},chart,time);assert.equal(stalled.status,'partial');assert.equal(stalled.pages,1);
});

test('daily ranges use Korean/New York local days including DST and cross-midnight trades',()=>{
  const now=Date.parse('2026-11-27T12:00:00Z'),kr=chartRange(chart,now);assert.equal(kr.from,Date.parse('2026-11-25T15:00:00Z'));assert.equal(kr.until,Date.parse('2026-11-26T15:00:00Z')-1);
  const us=chartRange({...chart,market:'US'},now);assert.equal(us.from,Date.parse('2026-11-26T05:00:00Z'));
  const dst=chartRange({...chart,market:'US',date:'2026-11-01'},now);assert.equal(dst.until-dst.from+1,25*3600000);
});

test('long histories have a bounded page budget and remain partial instead of claiming full coverage',async()=>{
  const load=createChartCandleLoader();let calls=0;
  const client={async get(path,p){calls++;const t=Date.parse(p.before)-60000;return{candles:[candle(t)],nextBefore:new Date(t).toISOString()};}};
  const result=await load({},client,chart,time);assert.equal(calls,12);assert.equal(result.status,'partial');assert.equal(result.candles.length,12);
});
