import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPatterns, patternReport, archivePatternEvidence, candleEvidence, completedCycles } from '../server/chart-patterns.mjs';

const cutoff = Date.parse('2026-11-26T11:00:00+09:00');
const prices = [108,106,103,100,101,103,106,109,106,103,101,100.2,102,104,106,108,108.3,108.6,108.8,110];
const points = values => values.map((price,i) => ({ time: cutoff - (values.length - 1 - i)*60000, price }));
function state(values = prices, pnl = -25000) {
  return { cash: 10000000, positions: [], dailyPolicy: { pending: null }, trades: [
    { id:'1',symbol:'TEST',name:'Test',side:'BUY',quantity:5,time:cutoff,price:110,priceUsd:110,patternEvidence:{source:'candles',points:points(values)},costs:{commission:10} },
    { id:'2',symbol:'TEST',side:'BUY',quantity:5,time:cutoff+1000,price:110,costs:{commission:10} },
    { id:'3',symbol:'TEST',side:'SELL',quantity:4,time:cutoff+60000,realized:pnl*.4,costs:{commission:10} },
    { id:'4',symbol:'TEST',side:'SELL',quantity:6,time:cutoff+120000,realized:pnl*.6,costs:{commission:10} },
  ] };
}
test('double bottom and top require a new breakout and confirmed extrema; future prices cannot change the signal', () => {
  const p=points(prices);
  assert.deepEqual(detectPatterns(p,cutoff).signals.map(s=>s.id),['doubleBottom']);
  assert.deepEqual(detectPatterns(points(prices.map(p=>210-p)),cutoff).signals.map(s=>s.id),['doubleTop']);
  assert.equal(detectPatterns(p.slice(0,-1),cutoff).status,'unavailable');
  assert.deepEqual(detectPatterns([...p,{time:cutoff+60000,price:1}],cutoff),detectPatterns(p,cutoff));
  const unbroken=[...prices.slice(0,-1),109];assert.equal(detectPatterns(points(unbroken),cutoff).signals.length,0);
  const stale=p.map(p=>({...p,time:p.time-4*60000}));assert.equal(detectPatterns(stale,cutoff).status,'unavailable');
  const gaps=p.map((p,i)=>({...p,time:p.time-(i<10?5*60000:0)}));assert.equal(detectPatterns(gaps,cutoff).status,'unavailable');
});
test('missing data stays unknown, while adequate no-signal data can keep or reject the entry',()=>{
  const s=state(Array.from({length:20},(_,i)=>100+i*.2));
  assert.equal(patternReport(s,'KR').summary.kept,1);
  assert.equal(patternReport(s,'KR',{mode:'require-bullish'}).summary.skipped,1);
  s.trades[0].patternEvidence.points=[];
  const report=patternReport(s,'KR');assert.equal(report.summary.comparable,0);assert.equal(report.summary.simulated,null);assert.equal(report.rows[0].simulated,null);
});
test('counterfactual groups partial fills; preserves realized costs/FX and never changes account or policy',()=>{
  const s=state(prices.map(p=>210-p)),before=structuredClone(s);
  const r=patternReport(s,'US');assert.equal(r.summary.completed,1);assert.equal(r.summary.baseline,-25000);assert.equal(r.summary.simulated,0);assert.equal(r.summary.difference,25000);
  assert.equal(r.rows[0].quantity,10);assert.equal(r.rows[0].fillCount,4);assert.deepEqual(s,before);
  const kept=patternReport(state(prices,30000),'US',{mode:'require-bullish'});assert.equal(kept.summary.simulated,30000);assert.equal(kept.summary.difference,0);
});
test('incomplete positions, unmatched sells, reentries and missing realized values are not silently counted as complete comparisons',()=>{
  const s=state();s.trades.pop();let r=patternReport(s,'KR');assert.equal(r.summary.open,1);assert.equal(r.summary.completed,0);
  s.trades=[{id:'0',side:'SELL',symbol:'OLD',quantity:1,time:cutoff-1},...state().trades,...state().trades.map(t=>({...t,id:String(Number(t.id)+4),time:t.time+3600000}))];
  assert.equal(completedCycles(s.trades).complete.length,2);assert.equal(patternReport(s,'KR').summary.unmatched,1);
  delete s.trades[3].realized;assert.equal(patternReport(s,'KR').rows[0].decision,'unavailable');
});
test('snapshot archives only entry-time data and completed candles; later captures cannot leak back into a trade',()=>{
  const series={candles:prices.map((closePrice,i)=>({timestamp:new Date(cutoff-(prices.length-i)*60000).toISOString(),closePrice}))};
  series.candles.push({timestamp:new Date(cutoff).toISOString(),closePrice:500});
  const evidence=candleEvidence(series,cutoff);assert.equal(evidence.points.length,20);assert.equal(evidence.points.at(-1).price,110);
  const s=state();delete s.trades[0].patternEvidence;
  archivePatternEvidence(s,cutoff,[{symbol:'TEST',patternEvidence:evidence}]);
  const saved=structuredClone(s.trades[0].patternEvidence);s.reviewEvidence={day:{points:[{symbol:'TEST',time:cutoff-60000,observedAt:cutoff+1,price:999}]}};
  archivePatternEvidence(s,cutoff+60000);assert.deepEqual(s.trades[0].patternEvidence,saved);
  const late=state();delete late.trades[0].patternEvidence;late.reviewEvidence=s.reviewEvidence;
  archivePatternEvidence(late,cutoff,[{symbol:'TEST',patternEvidence:{...evidence,capturedAt:cutoff+1}}]);
  assert.equal(late.trades[0].patternEvidence.points.length,0);
});
test('analysis inputs are bounded and invalid modes/patterns cannot be accepted',()=>{
  for(const o of [{mode:'trade'},{pattern:'unknown'},{tolerance:Infinity},{lookback:100000}])assert.throws(()=>patternReport(state(),'KR',o));
});
test('head/shoulders, converging triangles and both wedge directions use their own confirmed boundaries',()=>{
  const interpolate = anchors => Array.from({length:anchors.at(-1)[0]+1},(_,i)=>{
    const right=anchors.findIndex(a=>a[0]>=i);if(!right)return anchors[0][1];
    const [x0,y0]=anchors[right-1],[x1,y1]=anchors[right];return y0+(y1-y0)*(i-x0)/(x1-x0);
  });
  const head=interpolate([[0,110],[4,100],[10,106],[16,95],[22,106],[28,100.4],[34,105.9],[35,107]]);
  const triangle=interpolate([[0,105],[4,112],[8,100],[12,110],[16,102],[20,108],[24,104],[26,106],[27,108.4]]);
  const wedge=interpolate([[0,105],[4,112],[8,100],[12,108],[16,99],[20,104],[24,98],[26,100.2],[27,102]]);
  for(const [values,id] of [[head,'inverseHead'],[head.map(p=>210-p),'head'],[triangle,'triangleUp'],[triangle.map(p=>210-p),'triangleDown'],[wedge,'fallingWedge'],[wedge.map(p=>210-p),'risingWedge']]) {
    assert.ok(detectPatterns(points(values),cutoff).signals.some(s=>s.id===id),id);
  }
});
