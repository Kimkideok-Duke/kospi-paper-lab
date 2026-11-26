import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayFills} from '../web/trade-chart-layout.mjs';
test('crowded partial fills combine by side and five-minute bucket while selected execution keeps exact coordinates',()=>{
  const fills=Array.from({length:89},(_,i)=>({id:String(i),time:1000000+1000*i,price:3400+i,quantity:i+1,side:i<15?'BUY':'SELL'}));
  const before=structuredClone(fills),rows=displayFills(fills,'80');
  assert.ok(rows.length<10);assert.deepEqual(fills,before);
  const chosen=rows.find(t=>t.id==='80');assert.equal(chosen.price,fills[80].price);assert.equal(chosen.time,fills[80].time);
  for(const row of rows.filter(r=>r.members.length>1)){assert.ok(row.members.every(t=>t.side===row.side));assert.equal(row.quantity,row.members.reduce((n,t)=>n+t.quantity,0));assert.equal(row.price,row.members.reduce((n,t)=>n+t.price*t.quantity,0)/row.quantity);}
});
test('small fill sets retain every exact point',()=>{
  const fills=[{id:'1',time:1,price:1,quantity:2,side:'BUY'}];assert.equal(displayFills(fills,'1')[0].price,1);assert.equal(displayFills(fills,'1').length,1);
});
