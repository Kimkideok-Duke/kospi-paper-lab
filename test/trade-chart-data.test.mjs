import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartCandles,originalChartUrl,chartFills} from '../web/trade-chart-data.mjs';
test('provider minute ends become interval starts and five-minute bars preserve true OHLC and volume',()=>{
  const t=Date.parse('2026-11-26T09:01:00+09:00'),candles=[{time:t,open:100,high:110,low:90,close:105,volume:5},{time:t+60000,open:105,high:120,low:95,close:115,volume:7},{time:t+300000,open:115,high:125,low:110,close:120,volume:0}];
  const before=structuredClone(candles),one=chartCandles(candles),five=chartCandles(candles,5);
  assert.equal(one[0].time,(t-60000)/1000);assert.equal(five.length,2);assert.deepEqual(five[0],{time:(t-60000)/1000,open:100,high:120,low:90,close:115,volume:12});assert.deepEqual(candles,before);
});
test('original chart links encode only a public symbol and never contain trade details',()=>{
  const kr=new URL(originalChartUrl('KR','005930')),us=new URL(originalChartUrl('US','AAPL'));
  assert.equal(kr.origin,'https://www.tradingview.com');assert.equal(kr.searchParams.get('symbol'),'KRX:005930');assert.equal(us.searchParams.get('symbol'),'AAPL');assert.equal([...kr.searchParams].length,1);
});
test('partial fills occupy their candle without adding sub-minute time slots, retaining the selected execution separately',()=>{
  const start=Date.parse('2026-11-26T09:00:00+09:00'),fills=Array.from({length:100},(_,i)=>({id:String(i),side:i<50?'BUY':'SELL',time:start+i*100,quantity:2,price:100+i,reason:'판단'}));
  const before=structuredClone(fills),rows=chartFills(fills,'1',5),selected=rows.find(r=>r.id==='1');
  assert.equal(rows.length,3);assert.equal(selected.time,fills[1].time);assert.equal(selected.price,fills[1].price);assert.ok(rows.every(r=>r.markerTime===start/1000));
  assert.equal(rows.reduce((n,r)=>n+r.members.length,0),100);assert.deepEqual(fills,before);
});
