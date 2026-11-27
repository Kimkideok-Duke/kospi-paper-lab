import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceAt,historicalContext,validateArchive} from '../research/evidence.mjs';
test('replay excludes future publications, delayed availability and corrected versions',()=>{
  const item={publishedAt:10,availableAt:11,versionAt:10,url:'https://example.com/1'};
  const rows=[item,{...item,publishedAt:30},{...item,availableAt:30},{...item,versionAt:30}];
  assert.deepEqual(evidenceAt(rows,20),[item]);
});
test('missing event archive is unknown even when no events were supplied',()=>{
  assert.equal(historicalContext({time:20},[]).status,'missing-evidence');
  assert.ok(validateArchive({market:'KR',start:'2026-05-01',snapshots:[]}).length);
});

test('historical bearish disclosure is used only after publication and pattern sees no future candle',async()=>{
  const {replay}=await import('../research/replay.mjs');
  const time=Date.parse('2026-05-04T10:00:00+09:00');
  const row={symbol:'TEST',name:'테스트',type:'주식',date:'2026-05-04',time,availableAt:time,price:10000,
    regularStart:time-3600000,regularEnd:time+3600000,previousPrices:{},previousAvailableAt:time,
    candidate:{eligible:true,signalTime:time,momentum:1,reason:'기록된 신호'},
    coverage:{news:'complete',disclosures:'complete',universe:'point-in-time',from:time-60000,until:time},
    book:{time,asks:[{price:9990,volume:10000}],bids:[{price:9989,volume:10000}]}};
  const event={symbol:'TEST',kind:'disclosure',title:'회생절차 신청',source:'DART',
    publishedAt:time-1000,availableAt:time-1000,versionAt:time-1000,url:'https://example.com/filing'};
  const archive={market:'KR',start:'2026-05-01',sessionDates:['2026-05-04'],snapshots:[row],events:[event]};
  const params={momentum:.15,spread:.2,pattern:true};
  const options={from:'2026-05-01',until:'2026-05-05'};
  assert.equal(replay(archive,params,options).decisions[0].eligible,false);
  archive.events=[{...event,publishedAt:time+1000}];
  assert.equal(replay(archive,params,options).decisions[0].eligible,true);
  const context=historicalContext({...row,points:[{time:time+1000,observedAt:time+1000,price:50000}]},[],true);
  assert.equal(context.pattern.points.length,0);
});

test('community and X evidence rejects retrospective edits and copied posts',async()=>{
  const {socialContext}=await import('../research/social-evidence.mjs');
  const base={kind:'social',title:'시장 상승',url:'https://x.com/example/status/1',
    publishedAt:10,availableAt:11,versionAt:10,identityVerified:true,originalVersionVerified:true};
  assert.equal(socialContext([base,{...base,url:'https://x.com/example/status/2'}],20).count,1);
  assert.equal(socialContext([{...base,versionAt:30},{...base,identityVerified:false}],20).count,0);
});
