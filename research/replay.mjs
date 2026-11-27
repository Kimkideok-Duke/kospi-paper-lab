import {socialContext} from './social-evidence.mjs';
import {initialState,sellReason} from '../server/engine.mjs';
import {upgradePaper,executePaper,paperTotal} from '../server/paper-model.mjs';
import {classifyEvent} from '../server/market-events.mjs';
import {historicalContext,validateArchive} from './evidence.mjs';

export function replay(archive,parameters,{from,until}) {
  const errors=validateArchive(archive);
  if(errors.length) return {status:'blocked',errors};
  const rows=archive.snapshots.filter(r=>r.date>=from&&r.date<=until).sort((a,b)=>a.time-b.time);
  const state=initialState(),quotes=new Map(),books=new Map();
  let peak=10000000,drawdown=0;
  const decisions=[];
  for(const row of rows) {
    upgradePaper(state,'KR',row.time);
    quotes.set(row.symbol,{price:row.price,time:row.time});
    books.set(row.symbol,{...row.book,timestamp:new Date(row.book.time).toISOString(),currency:'KRW'});
    const context=historicalContext(row,archive.events,parameters.pattern);
    const relevant=[...context.news,...context.disclosures].filter(e=>row.time-e.availableAt<=20*60000);
    const adverse=relevant.some(e=>classifyEvent(e).direction<0);
    const bearish=context.pattern?.signals.some(p=>p.direction==='bearish');
    const spread=(Number(row.book.asks[0]?.price)/Number(row.book.bids[0]?.price)-1)*100;
    const eligible=row.candidate?.eligible===true && row.candidate.signalTime<=row.time &&
      row.candidate.momentum>=parameters.momentum && spread<=parameters.spread && !adverse && !bearish;
    const candidates=eligible?[{symbol:row.symbol,name:row.name,type:row.type,momentum:row.candidate.momentum,
      score:row.candidate.score,news:{caution:adverse},validPrice:p=>Math.abs(p/row.price-1)<=0.008,
      reason:row.candidate.reason+' · 당시 뉴스·공시 확인'}]:[];
    executePaper(state,{market:'KR',now:row.time,regularStart:row.regularStart,regularEnd:row.regularEnd,
      quotes,books,candidates,previous:row.previousPrices,reasonFor:sellReason,
      openingExit:p=>p.symbol===row.symbol&&adverse?'장중 악재 보호 매도':null});
    const total=paperTotal(state,'KR');
    peak=Math.max(peak,total);
    drawdown=Math.max(drawdown,(peak-total)/peak*100);
    decisions.push({time:row.time,symbol:row.symbol,eligible,evidence:relevant.map(e=>e.url),
      pattern:context.pattern?.signals??[],social:socialContext(archive.events??[],row.time)});
  }
  const equity=paperTotal(state,'KR');
  const sellOrders=new Set(state.trades.filter(t=>t.side==='SELL').map(t=>t.orderId)).size;
  return {status:'complete',parameters,from,until,returnPct:(equity/10000000-1)*100,
    maxDrawdownPct:drawdown,sellOrders,fills:state.trades.length,decisions};
}
export function searchArchive(archive,end) {
  const errors=validateArchive(archive);
  if(errors.length)return {status:'blocked',errors,promote:false};
  const trials=[];
  for(const momentum of [.15,.2,.25])for(const spread of [.1,.15,.2])for(const pattern of [false,true]){
    const parameters={momentum,spread,pattern};
    const train=replay(archive,parameters,{from:'2026-05-01',until:'2026-08-31'});
    const validation=replay(archive,parameters,{from:'2026-09-01',until:'2026-10-31'});
    trials.push({parameters,train,validation});
  }
  const qualified=trials.filter(t=>t.train.returnPct>0&&t.validation.returnPct>0&&
    t.validation.sellOrders>=5&&t.validation.maxDrawdownPct<=5);
  qualified.sort((a,b)=>b.validation.returnPct-a.validation.returnPct);
  const best=qualified[0];
  return {status:'complete',trials,promote:false,
    candidate:best?.parameters??null,
    holdout:best?replay(archive,best.parameters,{from:'2026-11-01',until:end}):null,
    note:'별도 구간의 현금 시작 모의 비교. 선정 후보는 운영 적용 전 독립 검토 필요. 전체 전략 재현 범위는 입력 archive의 품질에 의존.'};
}
