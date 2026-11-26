import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMonitorBatch, monitorStatus, MONITOR_INTERVAL_MS } from '../server/monitor-batch.mjs';
import { upgradePaper } from '../server/paper-model.mjs';
import { initialState } from '../server/engine.mjs';
import { recordAnalytics, analyticsView } from '../server/paper-analytics.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('five-second monitoring does not overlap or replay missed ticks after slow requests',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});let resolveRun,calls=0;
  const stop=startMonitorBatch(()=>{calls++;return calls===1?new Promise(resolve=>{resolveRun=resolve;}):Promise.resolve({status:'ok'});});
  t.mock.timers.tick(5000);await flush();assert.equal(calls,1);
  t.mock.timers.tick(21000);await flush();assert.equal(calls,1);
  resolveRun({status:'ok'});await flush();t.mock.timers.tick(3999);await flush();assert.equal(calls,1);
  t.mock.timers.tick(1);await flush();assert.equal(calls,2);stop();t.mock.timers.tick(60000);await flush();assert.equal(calls,2);
  assert.equal(MONITOR_INTERVAL_MS,5000);
});
test('reported monitor failures back off then resume five-second cadence on success',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});let calls=0;
  const stop=startMonitorBatch(async()=>({status:++calls<3?'error':'ok'}));
  t.mock.timers.tick(5000);await flush();assert.equal(calls,1);
  t.mock.timers.tick(9999);await flush();assert.equal(calls,1);t.mock.timers.tick(1);await flush();assert.equal(calls,2);
  t.mock.timers.tick(20000);await flush();assert.equal(calls,3);t.mock.timers.tick(5000);await flush();assert.equal(calls,4);stop();
  assert.equal(monitorStatus([{status:'outside'},{status:'error'}]).status,'error');
});
test('monitor policy migration records once and preserves existing pending orders, cash, positions, fills and cost settings',()=>{
  const s=upgradePaper(initialState(),'KR',1000);delete s.monitorPolicy;
  s.paperOrders.push({id:'existing',status:'PENDING',side:'BUY'});
  const before=structuredClone({cash:s.cash,positions:s.positions,trades:s.trades,orders:s.paperOrders,config:s.paperModel.config}),count=s.versions.length;
  upgradePaper(s,'KR',2000);assert.equal(s.monitorPolicy.intervalMs,5000);assert.equal(s.versions.length,count+1);
  assert.deepEqual({cash:s.cash,positions:s.positions,trades:s.trades,orders:s.paperOrders,config:s.paperModel.config},before);
  upgradePaper(s,'KR',3000);assert.equal(s.versions.length,count+1);
});
test('five-second intraminute drawdowns remain visible even when the display history keeps only the minute end',()=>{
  const s=upgradePaper(initialState(),'KR',1000);
  s.cash=11000000;recordAnalytics(s,'KR',1000);
  s.cash=9900000;recordAnalytics(s,'KR',6000);
  s.cash=11000000;recordAnalytics(s,'KR',11000);
  s.history=[{time:11000,total:11000000}];
  assert.equal(analyticsView(s,'KR').maxDrawdownPct,10);
});
