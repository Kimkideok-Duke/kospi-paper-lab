import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPublicWatch,publicPortfolio,WATCH_LIMIT,WATCH_TTL} from '../server/public-watch.mjs';
import {createWatchGateway} from '../server/watch-gateway.mjs';
const base='http://127.0.0.1:8765';
const request=(path,{cookie='',method='GET',origin=base,...headers}={})=>new Request(base+path,{method,headers:{cookie,origin,...headers}});
const cookie=r=>r.headers.get('set-cookie').split(';')[0];
function fixture(){let time=Date.parse('2026-11-27T01:00:00Z'),reads=0;
  const state={cash:9000000,username:'PRIVATE_MARKER',email:'PRIVATE_MARKER',secrets:'PRIVATE_MARKER',lastError:'PRIVATE_MARKER',scans:[{reason:'PRIVATE_MARKER'}],positions:[{symbol:'005930',name:'삼성전자',quantity:10,price:100000,entry:90000,owner:'PRIVATE_MARKER'}],history:[{time:time-1000,total:10000000,source:'PRIVATE_MARKER'}],trades:[{id:'PRIVATE_MARKER',time,side:'SELL',symbol:'005930',name:'삼성전자',quantity:1,price:100000,priceUsd:10,realized:100,reason:'PRIVATE_MARKER',orderId:'PRIVATE_MARKER',costs:{secret:'PRIVATE_MARKER'}}],reviewDayCharts:{secret:'PRIVATE_MARKER'}};
  const handle=createPublicWatch({db:{prepare(sql){assert.match(sql,/^SELECT state FROM (campaign|us_campaign) WHERE id=1$/);return{async first(){reads++;await Promise.resolve();return{state:JSON.stringify(state)};}};}},now:()=>time});
  return{handle,state,advance:ms=>{time+=ms;},reads:()=>reads};
}
test('anonymous viewer projects explicit numeric/instrument fields only, shares one cached snapshot, never serves internal routes or arbitrary methods',async()=>{
  const f=fixture(),join=await f.handle(request('/watch/join',{method:'POST','x-forwarded-proto':'https'})),viewer=cookie(join);
  assert.equal(join.status,200);assert.match(join.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Path=\/watch; Max-Age=90; Secure/);
  const responses=await Promise.all([f.handle(request('/watch/data',{cookie:viewer})),f.handle(request('/watch/join',{method:'POST'}))]);
  const second=cookie(responses[1]),data=await responses[0].json();const other=await f.handle(request('/watch/data',{cookie:second}));assert.equal(other.status,200);assert.equal(f.reads(),2);
  assert.ok(!JSON.stringify(data).includes('PRIVATE_MARKER'));assert.deepEqual(Object.keys(data),['asOf','refreshSeconds','capacity','markets']);
  assert.deepEqual(Object.keys(data.markets[0].trades[0]),['time','symbol','name','side','quantity','price','realized']);assert.equal(data.markets[0].total,10000000);
  assert.equal((await f.handle(request('/watch/data',{cookie:viewer}))).status,429);
  assert.equal((await f.handle(request('/watch/data',{method:'POST',cookie:viewer}))).status,405);
  assert.equal((await f.handle(request('/watch/api/state',{cookie:viewer}))).status,404);
  assert.equal((await f.handle(request('/watch/join',{method:'POST',origin:'https://evil.example'}))).status,403);
  assert.equal(await f.handle(request('/api/state',{cookie:viewer})),null);
  f.advance(15001);assert.equal((await f.handle(request('/watch/data',{cookie:viewer}))).status,200);assert.equal(f.reads(),4);
  const poisoned=publicPortfolio({...f.state,trades:[{side:'SELL',symbol:'<script>',name:'<img>',time:'PRIVATE_MARKER',price:'PRIVATE_MARKER'}]},'KR');assert.equal(poisoned.trades[0].symbol,'—');assert.equal(poisoned.trades[0].price,null);
});
test('20 active anonymous browser sessions are enforced server-side, invalid tokens cannot read; inactive viewers expire and free capacity',async()=>{
  const f=fixture(),viewers=[];
  for(let i=0;i<WATCH_LIMIT;i++){f.advance(1000);const r=await f.handle(request('/watch/join',{method:'POST'}));assert.equal(r.status,200);viewers.push(cookie(r));}
  assert.equal(new Set(viewers).size,WATCH_LIMIT);
  assert.equal((await f.handle(request('/watch/join',{method:'POST'}))).status,429);
  assert.equal((await f.handle(request('/watch/data',{cookie:'marketlab_viewer=forged'}))).status,410);
  assert.equal((await f.handle(request('/watch/join',{method:'POST',cookie:viewers[0]}))).status,200);
  f.advance(WATCH_TTL+1);assert.equal((await f.handle(request('/watch/data',{cookie:viewers[0]}))).status,410);
  assert.equal((await f.handle(request('/watch/join',{method:'POST'}))).status,200);
});
test('dedicated public gateway blocks login, private APIs, file/traversal and mutation routes even with owner cookies; only viewer cookie and allowlisted headers pass',async t=>{
  const seen=[],backend=http.createServer((req,res)=>{seen.push({path:req.url,headers:req.headers});res.setHeader('content-type','application/json');res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");res.setHeader('x-frame-options','DENY');res.setHeader('x-owner-email','PRIVATE_MARKER');res.end('{}');});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));const gateway=createWatchGateway({backend:'http://127.0.0.1:'+backend.address().port});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{gateway.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>backend.close(r))]);});
  const base='http://127.0.0.1:'+gateway.address().port;
  for(const path of ['/login','/settings','/api/state','/api/connect','/watch/../api/state','/.git/config','/watch/%2e%2e/api/state'])assert.equal((await fetch(base+path,{headers:{cookie:'marketlab_session=OWNER','oai-authenticated-user-id':'owner'}})).status,404);
  assert.equal(seen.length,0);
  const r=await fetch(base+'/watch/data?user=someone',{headers:{cookie:'marketlab_session=OWNER; marketlab_viewer='+'a'.repeat(48),authorization:'secret','oai-authenticated-user-id':'owner'}});assert.equal(r.status,200);assert.equal(r.headers.get('x-owner-email'),null);
  assert.equal(seen[0].path,'/watch/data');assert.equal(seen[0].headers.cookie,'marketlab_viewer='+'a'.repeat(48));assert.equal(seen[0].headers.authorization,undefined);assert.equal(seen[0].headers['oai-authenticated-user-id'],undefined);
  assert.equal((await fetch(base+'/watch/data',{method:'POST'})).status,405);assert.equal((await fetch(base+'/watch/join',{method:'POST',headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/watch/join',{method:'POST',headers:{origin:base.replace('http:','https:')}})).status,200);assert.equal(seen[1].headers.origin,'http://127.0.0.1:'+backend.address().port);
  for(const path of ['/watch','/watch/watch.js','/watch/watch.css']){
    const r=await fetch(base+path,{method:'HEAD'});assert.equal(r.status,200);assert.equal(await r.text(),'');
    assert.equal(r.headers.get('x-frame-options'),null);assert.ok(!r.headers.get('content-security-policy').includes('frame-ancestors'));
    assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
  }
  assert.equal((await fetch(base+'/',{method:'HEAD',redirect:'manual'})).status,302);
  assert.equal((await fetch(base+'/settings',{method:'HEAD'})).status,404);
  assert.equal((await fetch(base+'/watch',{headers:{origin:'https://chatgpt.com'}})).status,200);
});
