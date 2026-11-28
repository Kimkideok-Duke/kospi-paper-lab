import {socialContext} from './social-evidence.mjs';
import {initialState,sellReason} from '../server/engine.mjs';
import {upgradePaper,executePaper,paperTotal} from '../server/paper-model.mjs';
import {classifyEvent} from '../server/market-events.mjs';
import {historicalContext,validateArchive,researchBook,researchSpread} from './evidence.mjs';
import {completedCycles} from '../server/chart-patterns.mjs';

export const REFERENCE_PARAMETERS=Object.freeze({momentum:.15,spread:.2,pattern:false});

export function qualification(trial,reference){
  const reasons=[],train=trial.train,validation=trial.validation,baseline=reference.validation;
  for(const [name,result] of [['학습',train],['검증',validation]]){
    if(result?.status!=='complete'){reasons.push(name+' 실행 미완료');continue;}
    if(!(result.completedTrips>=5&&result.completedDays>=2))reasons.push(name+' 완결 매매5회·거래일2일 표본 부족');
  }
  if(baseline?.status!=='complete')reasons.push('기준선 실행 미완료');
  if(reasons.length)return {qualified:false,reasons};
  const metrics=[train.returnPct,validation.returnPct,validation.maxDrawdownPct,validation.explicitCosts,validation.slippage,baseline.returnPct,baseline.maxDrawdownPct,baseline.explicitCosts,baseline.slippage];
  if(!metrics.every(Number.isFinite))return {qualified:false,reasons:['수익·낙폭·비용 지표 누락']};
  if(train.returnPct<=0||validation.returnPct<=0)reasons.push('학습·검증 순수익 양수 조건 미충족');
  if(validation.returnPct<=baseline.returnPct+1e-9)reasons.push('동일 자료 기준선 대비 검증 수익 개선 없음');
  if(validation.maxDrawdownPct>5||validation.maxDrawdownPct>baseline.maxDrawdownPct+1e-9)reasons.push('검증 최대 낙폭 한도 또는 기준선 초과');
  if(validation.explicitCosts>baseline.explicitCosts||validation.slippage>baseline.slippage+1e-9)reasons.push('검증 비용 또는 가격 반영 슬리피지 악화');
  return {qualified:!reasons.length,reasons};
}

export function replay(archive,parameters,{from,until}) {
  const errors=validateArchive(archive);
  if(errors.length) return {status:'blocked',errors};
  const rows=archive.snapshots.filter(r=>r.date>=from&&r.date<=until).sort((a,b)=>a.time-b.time);
  if(!rows.length)return {status:'blocked',parameters,from,until,errors:['선택한 기간의 과거 스냅샷 없음']};
  const state=initialState(),quotes=new Map(),books=new Map();
  let peak=10000000,drawdown=0;
  const decisions=[];
  for(const row of rows) {
    upgradePaper(state,'KR',row.time);
    quotes.set(row.symbol,{price:row.price,time:row.time});
    const book=researchBook(row.book);
    books.set(row.symbol,{...book,timestamp:new Date(book.time).toISOString(),currency:'KRW'});
    const context=historicalContext(row,archive.events,parameters.pattern);
    const relevant=[...context.news,...context.disclosures].filter(e=>row.time-e.availableAt<=20*60000);
    const adverse=relevant.some(e=>classifyEvent(e).direction<0);
    const bearish=context.pattern?.signals.some(p=>p.direction==='bearish');
    const spread=researchSpread(book);
    const eligible=row.candidate?.eligible===true && row.candidate.signalTime<=row.time &&
      row.candidate.momentum>=parameters.momentum && Number.isFinite(spread) && spread<=parameters.spread && !adverse && !bearish;
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
  const complete=completedCycles(state.trades).complete.filter(c=>!c.invalid&&c.sells.every(t=>Number.isFinite(t.realized)));
  const completedDays=new Set(complete.map(c=>new Date(c.sells.at(-1).time+9*3600000).toISOString().slice(0,10))).size;
  const costs=state.costs??{};
  return {status:'complete',parameters,from,until,returnPct:(equity/10000000-1)*100,
    maxDrawdownPct:drawdown,sellOrders,completedTrips:complete.length,completedDays,
    explicitCosts:(costs.commission??0)+(costs.transactionTax??0)+(costs.fxSpread??0),
    slippage:costs.slippage??0,fills:state.trades.length,decisions};
}
export function searchArchive(archive,end,{referenceParameters=REFERENCE_PARAMETERS}={}) {
  const errors=validateArchive(archive);
  if(errors.length)return {status:'blocked',errors,promote:false};
  const trials=[];
  for(const momentum of [.15,.2,.25])for(const spread of [.1,.15,.2])for(const pattern of [false,true]){
    const parameters={momentum,spread,pattern};
    const train=replay(archive,parameters,{from:'2026-05-01',until:'2026-08-31'});
    const validation=replay(archive,parameters,{from:'2026-09-01',until:'2026-10-31'});
    trials.push({parameters,train,validation});
  }
  const reference=trials.find(t=>Object.keys(REFERENCE_PARAMETERS).every(key=>t.parameters[key]===referenceParameters[key]))??{
    parameters:{...referenceParameters},
    train:replay(archive,referenceParameters,{from:'2026-05-01',until:'2026-08-31'}),
    validation:replay(archive,referenceParameters,{from:'2026-09-01',until:'2026-10-31'})};
  for(const trial of trials)trial.selection=qualification(trial,reference);
  const qualified=trials.filter(t=>t.selection.qualified);
  qualified.sort((a,b)=>b.validation.returnPct-a.validation.returnPct);
  const best=qualified[0];
  const incomplete=trials.some(t=>t.train.status!=='complete'||t.validation.status!=='complete')||reference.train.status!=='complete'||reference.validation.status!=='complete';
  return {status:incomplete?'blocked':'complete',...(incomplete?{errors:[...new Set(trials.flatMap(t=>[...(t.train.errors??[]),...(t.validation.errors??[])]))]}:{}),trials,promote:false,reference,
    candidate:best?.parameters??null,
    holdout:best?replay(archive,best.parameters,{from:'2026-11-01',until:end}):null,
    referenceHoldout:best?replay(archive,reference.parameters,{from:'2026-11-01',until:end}):null,
    note:'코드 기본 기준선 또는 명시한 기준선과 동일 자료·별도 현금 시작 구간 비교. 완결 매매 표본·수익·낙폭·명시 비용·가격 반영 슬리피지를 검사한다. 선정 후보는 운영 적용 전 독립 검토 필요. 전체 전략 재현 범위는 입력 archive의 품질에 의존.'};
}
