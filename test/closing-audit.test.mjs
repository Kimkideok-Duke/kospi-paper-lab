import assert from 'node:assert/strict';
import {test} from 'node:test';
import {closingSession,closingTargets,collectClosingAudits,closingReview} from '../server/closing-audit.mjs';
const date='2026-11-26',at=clock=>Date.parse(date+'T'+clock+':00+09:00');
const day={date,integrated:{regularMarket:{startTime:date+'T09:00:00+09:00',endTime:date+'T15:30:00+09:00'},afterMarket:{endTime:date+'T20:00:00+09:00'}}};
function state(count=1){return {cash:10000000-count*100,positions:[],history:[],daily:[{date,open:10000000,close:10000000}],reviews:{},reviewSessions:{[date]:closingSession(day,'KR')},trades:Array.from({length:count},(_,i)=>({id:String(i+1),symbol:'T'+i,name:'테스트'+i,side:'BUY',quantity:1,amount:100,cashAmount:101,time:at('10:00')}))};}
const candle=(symbol,d=date,currency='KRW')=>({candles:[{timestamp:d+'T00:00:00+09:00',closePrice:110,currency}]});
test('KR waits for integrated after-market completion; early-close US uses actual regular end',async()=>{
  const s=state();let calls=0;const client={get:async()=>{calls++;return candle();}};
  await collectClosingAudits(s,'KR',client,at('16:01'));assert.equal(calls,0);assert.equal(s.reviewCloseAudits[date].status,'waiting');
  await collectClosingAudits(s,'KR',client,at('20:01'));assert.equal(calls,1);assert.equal(s.reviewCloseAudits[date].status,'complete');
  const us=closingSession({date,regularMarket:{startTime:date+'T14:30:00Z',endTime:date+'T18:00:00Z'},afterMarket:{endTime:date+'T22:00:00Z'}},'US');assert.equal(us.closingEnd,Date.parse(date+'T18:00:00Z'));
});
test('every traded/held symbol is checked without the review 30-symbol cap; budgeted runs resume without re-querying successes',async()=>{
  const s=state(35),called=[];const client={get:async(path,p)=>{assert.equal(path,'candles');assert.equal(p.interval,'1d');assert.equal(p.adjusted,false);called.push(p.symbol);return candle(p.symbol);}};
  for(let i=0;i<5;i++)await collectClosingAudits(s,'KR',client,at('20:01')+i*60000,{budget:8});
  const a=s.reviewCloseAudits[date];assert.equal(a.targets.length,35);assert.equal(a.confirmed,35);assert.equal(a.status,'complete');assert.equal(new Set(called).size,35);assert.equal(called.length,35);
  await collectClosingAudits(s,'KR',client,at('21:00'));assert.equal(called.length,35);
});
test('wrong date/currency or missing candles stay pending, retries back off and only missing symbols are fetched again',async()=>{
  const s=state(2);let valid=false;const calls=[];const client={get:async(_,p)=>{calls.push(p.symbol);return p.symbol==='T1'&&!valid?candle(p.symbol,'2026-11-25'):candle(p.symbol);}};
  await collectClosingAudits(s,'KR',client,at('20:01'));assert.equal(s.reviewCloseAudits[date].confirmed,1);assert.equal(s.reviewCloseAudits[date].status,'partial');
  await collectClosingAudits(s,'KR',client,at('20:01')+30000);assert.equal(calls.length,2);
  valid=true;await collectClosingAudits(s,'KR',client,at('20:02'));assert.equal(calls.length,3);assert.equal(calls.at(-1),'T1');assert.equal(s.reviewCloseAudits[date].status,'complete');
});
test('historical dates fetch their own calendars and daily candles; later holdings/trades do not contaminate close-time quantities or cash',async()=>{
  const s=state();s.reviewSessions[date]={date,start:at('09:00'),end:at('15:30')};s.trades.push({id:'2',symbol:'FUTURE',side:'BUY',quantity:10,amount:100000,time:at('21:00')});
  const ctx=closingTargets(s,'KR',date,s.reviewSessions[date],at('20:01'));assert.deepEqual(ctx.targets.map(t=>t.symbol),['T0']);assert.equal(ctx.cash,9999899);
  let calendarCalls=0;await collectClosingAudits(s,'KR',{get:async(path,p)=>{if(path.startsWith('market-calendar')){calendarCalls++;assert.equal(p.date,date);return {today:day};}return candle();}},at('20:01'));
  assert.equal(calendarCalls,1);assert.equal(s.reviewCloseAudits[date].equity,10000009);
});
test('closing valuation is a view overlay; original fills, positions, cash and saved report remain unchanged',async()=>{
  const s=state();const report={date,market:'KR',summary:{endingEquity:9999990,equityPnl:-10},quality:['일부 또는 전체 종목의 마감 시세를 별도로 확인하지 못해 마지막 저장 평가금액이 포함됩니다.','다른 자료 한계'],adaptive:{changed:false}};s.reviews[date]=report;
  const before=structuredClone({cash:s.cash,trades:s.trades,positions:s.positions,report});
  await collectClosingAudits(s,'KR',{get:async()=>candle()},at('20:01'));const r=closingReview(s,report);
  assert.equal(r.summary.endingEquity,10000009);assert.equal(r.summary.equityPnl,9);assert.deepEqual(r.quality,['다른 자료 한계']);assert.equal(r.summary.regularEquityPnl,-10);
  assert.deepEqual({cash:s.cash,trades:s.trades,positions:s.positions,report:s.reviews[date]},before);
});
test('verified stock closes cannot falsely complete a won valuation when US closing FX evidence is absent',async()=>{
  const s=state();s.reviewSessions[date]=closingSession({date,regularMarket:{startTime:date+'T14:30:00Z',endTime:date+'T21:00:00Z'}},'US');s.trades[0].time=Date.parse(date+'T15:00:00Z');
  await collectClosingAudits(s,'US',{get:async()=>candle('',date,'USD')},Date.parse(date+'T21:01:00Z'));
  const a=s.reviewCloseAudits[date];assert.equal(a.status,'complete');assert.equal(a.valuationStatus,'missing-fx');assert.equal(a.equity,undefined);
});
