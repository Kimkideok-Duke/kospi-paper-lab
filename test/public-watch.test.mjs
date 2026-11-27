import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
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
test('public view returns only the latest five fills and saved same-period benchmark returns without exposing benchmark internals',()=>{
  const state={cash:9000000,trades:Array.from({length:12},(_,i)=>({side:'BUY',time:i+1,symbol:'SPY',quantity:1,price:100,reason:'PRIVATE_MARKER'})),benchmarks:{SPY:{symbol:'SPY',name:'SPY',since:1000,time:2000,baseStrategy:999999,basePrice:100,private:'PRIVATE_MARKER',returnPct:2,strategyPct:-1,points:[{time:2000,benchmarkPct:2,strategyPct:-1,private:'PRIVATE_MARKER'}]}}};
  const result=publicPortfolio(state,'US');assert.deepEqual(result.trades.map(t=>t.time),[12,11,10,9,8]);
  assert.deepEqual(result.benchmarks,[{symbol:'SPY',name:'SPY',since:1000,time:2000,strategyPct:-1,returnPct:2,points:[{time:2000,strategyPct:-1,benchmarkPct:2}]}]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MARKER'));assert.equal(result.benchmarks[0].strategyPct,-1);
});
test('public charts label money/time axes, preserve irregular elapsed time and compare saved market returns on desktop and mobile widths',()=>{
  class Node{constructor(){this.children=[];this.attributes={};this.textContent='';this.clientWidth=900;}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(key,value){this.attributes[key]=String(value);}}
  const nodes=new Map(),get=selector=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector);};
  const context=vm.createContext({Intl,document:{querySelector:get,createElement:()=>new Node(),createElementNS:()=>new Node()}});
  const source=readFileSync(new URL('../web/watch.js',import.meta.url),'utf8');vm.runInContext(source.slice(0,source.indexOf('async function call(')),context);
  const p={market:'KR',initial:10000000,total:10001000,cash:10001000,pnl:1000,positions:[],trades:[],history:[{time:1000000,total:10000000},{time:1060000,total:10000500},{time:1600000,total:10001000}],benchmarks:[{name:'KODEX 200',since:1000000,strategyPct:1,returnPct:2,points:[{time:1000000,strategyPct:0,benchmarkPct:0},{time:1600000,strategyPct:1,benchmarkPct:2}]}]};
  vm.runInContext('data='+JSON.stringify({asOf:1600000,markets:[p]})+'; render();',context);
  const chart=get('#chart'),line=chart.children.find(n=>n.attributes.points),coords=line.attributes.points.split(' ').map(p=>p.split(',').map(Number));
  assert.ok(Math.abs((coords[1][0]-coords[0][0])/(coords[2][0]-coords[0][0])-.1)<.00001);
  assert.ok(chart.children.some(n=>n.textContent==='금액 (원)'));assert.ok(chart.children.some(n=>n.textContent==='시간 (한국)'));
  assert.ok(get('#benchmark-chart').children.some(n=>n.textContent==='수익률 (%)'));
  assert.equal(get('#benchmark-rows').children[0].children.at(-1).textContent,'-1%p');
  // Pointer coordinates can be CSS-scaled; show the nearest saved observation, not interpolated money.
  chart.getBoundingClientRect=()=>({left:20,width:450});
  const labels=node=>[node.textContent,...node.children.flatMap(labels)];
  chart.onpointermove({clientX:20+(100+780*.1)/2,pointerType:'mouse'});
  assert.ok(labels(chart).includes('평가자산 10,000,500원'));
  chart.onpointerdown({clientX:20+100/2,pointerType:'touch'});chart.onfocus();chart.onpointerleave({pointerType:'touch'});
  assert.ok(labels(chart).includes('평가자산 10,000,000원'));assert.equal(chart.children.at(-1).attributes.visibility,'visible');
  chart.onpointerleave({pointerType:'mouse'});assert.equal(chart.children.at(-1).attributes.visibility,'hidden');
  chart.clientWidth=360;vm.runInContext('market="US"; plot(document.querySelector("#chart"),[{color:"blue",points:[{time:1,value:10000000}]}]);',context);
  assert.ok(chart.children.some(n=>n.textContent==='시간 (미국 동부)'));assert.ok(chart.children.every(n=>!JSON.stringify(n.attributes).includes('NaN')));assert.match(chart.attributes.viewBox,/360 280$/);
  chart.onfocus();chart.onkeydown({key:'ArrowLeft',preventDefault(){}});assert.ok(labels(chart).some(s=>s.includes('미국 동부')));chart.onkeydown({key:'Escape'});assert.equal(chart.children.at(-1).attributes.visibility,'hidden');
});
test('dedicated public gateway blocks login, private APIs, file/traversal and mutation routes even with owner cookies; only viewer cookie and allowlisted headers pass',async t=>{
  const seen=[],backend=http.createServer((req,res)=>{seen.push({path:req.url,headers:req.headers});res.setHeader('content-type','application/json');res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");res.setHeader('x-frame-options','DENY');res.setHeader('x-owner-email','PRIVATE_MARKER');res.end('{}');});
  const diagnostics=[];
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));const gateway=createWatchGateway({backend:'http://127.0.0.1:'+backend.address().port,onResponse:event=>diagnostics.push(event)});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
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
  const streamRequest=(method,headers={},body='')=>new Promise((resolve,reject)=>{
    const req=http.request(base+'/watch'+(method==='POST'?'/join':''),{method,headers},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);req.end(body);
  });
  assert.equal(await streamRequest('GET',{'transfer-encoding':'chunked'}),200);
  assert.equal(await streamRequest('GET',{'transfer-encoding':'chunked'},'x'),413);
  const manyHeaders=Object.fromEntries(Array.from({length:30},(_,i)=>['x-browser-header-'+i,'ignored']));
  assert.equal(await streamRequest('POST',{...manyHeaders,origin:base.replace('http:','https:'),'transfer-encoding':'chunked'}),200);
  assert.equal((await fetch(base+'/watch?PRIVATE_MARKER=secret',{headers:{cookie:'PRIVATE_MARKER=secret','user-agent':'PRIVATE_MARKER'}})).status,200);
  assert.ok(diagnostics.length>0);assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_MARKER'));
  assert.deepEqual(Object.keys(diagnostics[0]),['time','method','route','status','browser','chunked','declaredBody','durationMs']);
});
