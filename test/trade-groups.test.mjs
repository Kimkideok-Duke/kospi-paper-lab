import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupTradeFills} from '../web/trade-groups.mjs';
test('order display sums fills and preserves selectable original records',()=>{
  const rows=[
    {id:'1',orderId:'order',symbol:'A',side:'SELL',time:1,quantity:1,amount:100,realized:-2,total:1000,costs:{commission:1}},
    {id:'2',orderId:'order',symbol:'A',side:'SELL',time:2,quantity:2,amount:220,realized:-4,total:990,costs:{commission:2}},
    {id:'3',orderId:'other',symbol:'A',side:'SELL',time:3,quantity:1,amount:120},
    {id:'4',symbol:'A',side:'SELL',time:4,quantity:1,amount:120},
    {id:'5',symbol:'A',side:'SELL',time:5,quantity:1,amount:120}
  ];
  const original=structuredClone(rows), groups=groupTradeFills(rows);
  assert.equal(groups.length,4);
  assert.equal(groups[0].quantity,3);
  assert.equal(groups[0].amount,320);
  assert.equal(groups[0].price,320/3);
  assert.equal(groups[0].realized,-6);
  assert.equal(groups[0].total,990);
  assert.equal(groups[0].costs.commission,3);
  assert.equal(groups[0].id,'2');
  assert.deepEqual(groups[0].fills,rows.slice(0,2));
  assert.deepEqual(rows,original);
});
