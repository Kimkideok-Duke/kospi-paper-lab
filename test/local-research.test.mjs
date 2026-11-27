import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {scryptSync} from 'node:crypto';
import {createLocalResearch,researchRange} from '../server/local-research.mjs';
import {createLocalHost} from '../server/local-host.mjs';
import '../scripts/build.mjs';
const {readResearchData}=await import('../dist/server/index.js');
const now=()=>Date.parse('2026-11-27T12:00:00+09:00');
const range={start:'2026-05-01',end:'2026-11-26'};
const candle=time=>({timestamp:time,openPrice:'100',highPrice:'110',lowPrice:'90',closePrice:'101',volume:'3',currency:'KRW'});
async function fixture(t,readPage){const root=await mkdtemp(join(tmpdir(),'marketlab-research-'));const service=createLocalResearch({root,readPage,delay:()=>Promise.resolve(),now});t.after(async()=>{await service.close();assert.ok(root.startsWith(join(tmpdir(),'marketlab-research-')));await rm(root,{recursive:true,force:true});});return {root,service};}
async function settled(service,id='owner'){for(let i=0;i<200;i++){const state=await service.status(id);if(state.status!=='running')return state;await new Promise(r=>setTimeout(r,5));}throw Error('job did not settle');}

test('research refuses invalid, future and excessive ranges',()=>{
 for(const r of [{start:'2026-99-01',end:'2026-11-26'},{start:'2026-02-30',end:'2026-11-26'},{start:'2026-05-01',end:'2026-11-27'},{start:'2022-01-01',end:'2026-11-26'}])assert.throws(()=>researchRange(r.start,r.end,now()),e=>e.status===400);
 assert.equal(researchRange(range.start,range.end,now()).from,Date.parse('2026-05-01T00:00:00+09:00'));
});
test('research stores raw pages, checkpoints and isolates tenants without modifying input environment',async t=>{
 const env={private:'unchanged'};let calls=0;
 const {root,service}=await fixture(t,async(scope,kind,p)=>{assert.equal(scope,env);calls++;return kind==='stocks'?{stocks:[{symbol:'005930'}]}:{candles:[candle('2026-05-04T09:01:00+09:00')],nextBefore:null};});
 await service.start('owner',env,range);const done=await settled(service);
 assert.equal(done.status,'finished');assert.equal(done.bars,1);assert.equal(done.universe,'current-KOSPI-not-historical');assert.deepEqual(done.completed,['005930']);assert.deepEqual(env,{private:'unchanged'});
 const raw=JSON.parse(gunzipSync(await readFile(join(root,'research','005930','00000.json.gz'))));assert.equal(raw.candles[0].closePrice,'101');
 const other='12345678-1234-1234-1234-123456789012';assert.equal((await service.status(other)).status,'idle');
 await service.start('owner',env,range);await settled(service);assert.equal(calls,2);
 assert.deepEqual((await readdir(root)).sort(),['research']);await assert.rejects(()=>service.status('../owner'),e=>e.status===400);
});
test('research rejects concurrent starts and resumes at failed page without double counting',async t=>{
 let failed=false;const requests=[];
 const {service}=await fixture(t,async(env,kind,p)=>{
  if(kind==='stocks')return [{symbol:'005930'}];requests.push(p.before);
  if(requests.length===1)return {candles:[candle('2026-10-01T09:01:00+09:00')],nextBefore:'2026-10-01T09:01:00+09:00'};
  if(!failed){failed=true;throw Object.assign(Error('auth'),{status:401});}
  return {candles:[candle('2026-05-04T09:01:00+09:00')],nextBefore:null};
 });
 const first=service.start('owner',{},range);await assert.rejects(()=>service.start('owner',{},range),e=>e.status===409);await first;
 const paused=await settled(service);assert.equal(paused.status,'paused');assert.equal(paused.pages,1);assert.equal(paused.errorStatus,401);
 await service.start('owner',{},range);const done=await settled(service);assert.equal(done.pages,2);assert.equal(done.bars,2);assert.equal(requests[1],requests[2]);
});
test('research marks missing stocks and repeated cursors without inventing completeness',async t=>{
 const {service}=await fixture(t,async(env,kind,p)=>{if(kind==='stocks')return [{symbol:'005930'},{symbol:'000001'}];if(p.symbol==='005930')throw Object.assign(Error('missing'),{status:404});return {candles:[candle('2026-10-01T09:01:00+09:00')],nextBefore:p.before};});
 await service.start('owner',{},range);const state=await settled(service);assert.equal(state.status,'paused');assert.equal(state.errorStatus,502);assert.equal(state.completed.length,0);assert.deepEqual(state.unavailable,[{symbol:'005930',status:404}]);assert.equal(state.pages,0);
});
test('research host requires session and same origin; ignores caller-selected tenant',async t=>{
 const root=await mkdtemp(join(tmpdir(),'marketlab-research-'));const password='test-research-password',salt='salt';
 const host=createLocalHost({root,masterKey:'ab'.repeat(32),baseEnv:{},app:{fetch:()=>new Response('unused')},ownerCredentials:{username:'owner',salt,passwordHash:scryptSync(password,salt,32).toString('hex')},researchRead:async()=>[]});
 t.after(async()=>{await host.close();assert.ok(root.startsWith(join(tmpdir(),'marketlab-research-')));await rm(root,{recursive:true,force:true});});
 const origin='http://localhost';const req=(path,options={})=>host.fetch(new Request(origin+path,options));
 assert.equal((await req('/api/research')).status,401);assert.equal((await req('/research')).status,303);
 const login=await req('/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'owner',password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await req('/api/research?user=other',{headers:{cookie}})).status,200);
 const post={method:'POST',headers:{cookie,origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify({action:'start',...range})};assert.equal((await req('/api/research',post)).status,403);
 assert.equal((await req('/research',{headers:{cookie}})).status,200);
 assert.equal((await req('/api/research',{...post,headers:{...post.headers,origin},body:'{"action":"orders"}'})).status,400);
});

test('research reuses encrypted running token without token issuance or ledger writes',async t=>{
 const key='ab'.repeat(32),iv=new Uint8Array(12).fill(1),encode=new TextEncoder();
 const raw=Uint8Array.from(key.match(/../g),s=>parseInt(s,16));const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
 async function encrypted(token){const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode.encode('toss:token')},aes,encode.encode(JSON.stringify(token)));return Buffer.from(iv).toString('base64')+'.'+Buffer.from(data).toString('base64');}
 let token=await encrypted({value:'fake-test-research-token',expires:Date.now()+3600000});let reads=0,calls=0;
 const env={MARKETLAB_KEY:key,DB:{prepare(sql){assert.equal(sql,'SELECT * FROM campaign WHERE id = 1');reads++;return {first:async()=>({secrets:'present',access_token:token})};}}};
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(url.pathname,'/api/v1/candles');assert.equal(url.searchParams.get('symbol'),'0000A0');assert.equal(url.searchParams.get('adjusted'),'false');assert.equal(new Headers(options.headers).get('authorization'),'Bearer fake-test-research-token');return Response.json({result:{candles:[],nextBefore:null}});};
 assert.deepEqual(await readResearchData(env,'candles',{symbol:'0000A0',before:'2026-05-04T15:30:00+09:00'}),{candles:[],nextBefore:null});assert.equal(calls,1);
 token=await encrypted({value:'fake-test-research-token',expires:0});await assert.rejects(()=>readResearchData(env,'stocks'),e=>e.status===503);assert.equal(calls,1);assert.equal(reads,2);
});
