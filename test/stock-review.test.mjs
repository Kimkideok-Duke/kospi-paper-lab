import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stockReview} from '../server/stock-review.mjs';
import {fillReasons,displayFills} from '../web/trade-chart-layout.mjs';

test('a hundred fills produce one stock review, retaining counts, costs and evidence without rewriting the report',()=>{
  const decisions=Array.from({length:100},(_,i)=>({id:String(i),symbol:'TEST',name:'테스트',time:i,side:i<50?'BUY':'SELL',quantity:2,price:100,
    reason:i<50?'상승 확인':'손절',realized:i<50?0:-5,costs:{commission:1,transactionTax:2,fxSpread:0},alternative:i<10?{price:99,grossDifferenceKrw:2}:null}));
  const report={date:'2026-11-26',market:'KR',decisions},before=structuredClone(report),view=stockReview(report);
  assert.equal(view.stocks.length,1);const s=view.stocks[0];assert.equal(s.fillCount,100);assert.equal(s.buyQuantity,100);assert.equal(s.realized,-250);assert.equal(s.explicitCosts,300);
  assert.equal(s.buyReasons.length,1);assert.equal(s.buyReasons[0].fills,50);assert.deepEqual(s.comparison,{available:10,favorable:10,missing:90});
  assert.ok(s.improvements.some(v=>v.includes('1.00% 낮')));assert.deepEqual(report,before);
  const markers=displayFills(decisions,'0');const group=markers.find(m=>m.members.length>1);assert.equal(fillReasons(group)[0].count,50);
  assert.equal(fillReasons(markers.find(m=>m.id==='0'))[0].reason,'상승 확인');
});

test('legacy sell-only and buy-only reports preserve uncertainty and separate symbols',()=>{
  const report={date:'2026-11-25',market:'US',decisions:[{id:'1',symbol:'A',name:'A',side:'SELL',quantity:2,realized:200,reason:'익절'}, {id:'2',symbol:'B',name:'B',side:'BUY',quantity:1,reason:'진입'}]};
  const view=stockReview(report);assert.equal(view.stocks.length,2);assert.match(view.stocks[0].motivation,/이전 보유분/);assert.equal(view.stocks[0].missingCostFills,1);
  assert.ok(view.stocks[1].improvements.some(v=>v.includes('당일 매도가 없어')));assert.ok(view.stocks[0].improvements.some(v=>v.includes('확인할 수 없습니다')));
  assert.deepEqual(stockReview({...report,decisions:[]}).stocks,[]);assert.equal(stockReview(null),null);
  assert.match(fillReasons({members:[{},{}]})[0].reason,/없습니다/);
});
