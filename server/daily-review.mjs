import {marketDate,strategyPolicy} from './strategy-policy.mjs';
const sum=(rows,fn)=>rows.reduce((n,r)=>n+(Number(fn(r))||0),0);
const finite=value=>Number.isFinite(value)?value:null;
export function rememberSession(state,market){
  const day=state.calendar?.result?.today,regular=market==='US'?day?.regularMarket:day?.integrated?.regularMarket;
  const start=Date.parse(regular?.startTime),end=Date.parse(regular?.endTime);
  if(!day?.date||!Number.isFinite(start)||!Number.isFinite(end))return;
  state.reviewSessions??={};state.reviewSessions[day.date]={date:day.date,start,end,nextDate:state.calendar.result.nextBusinessDay?.date??null};
}
export function reviewSymbols(state,market,now){const date=marketDate(now,market);return [...new Set([...state.positions.map(p=>p.symbol),...state.trades.filter(t=>marketDate(t.time,market)===date).map(t=>t.symbol)])].slice(0,30);}
export function recordReviewEvidence(state,market,quotes,fx,now,candidates=null){
  rememberSession(state,market);const date=marketDate(now,market),session=state.reviewSessions?.[date];if(!session||now<session.start||now>session.end+15*60000)return;
  state.reviewEvidence??={};const evidence=state.reviewEvidence[date]??={points:[],analyses:[]};
  const wanted=new Set([...reviewSymbols(state,market,now),...(candidates??[]).slice(0,5).map(c=>c.symbol)]);
  for(const symbol of wanted){const q=quotes.get(symbol);if(!q||!(q.price>0)||q.time<session.start||q.time>session.end||q.time>now+3000||now-q.time>90000)continue;
    const point={symbol,time:q.time,price:q.price,fx:market==='US'?fx?.rate??null:1},bucket=Math.floor(q.time/60000);
    const index=evidence.points.findLastIndex(p=>p.symbol===symbol&&Math.floor(p.time/60000)===bucket);
    if(index<0)evidence.points.push(point);else if(evidence.points[index].time<q.time)evidence.points[index]=point;
  }
  if(candidates)evidence.analyses.push({time:now,policy:strategyPolicy(state),candidates:candidates.slice(0,5).map(c=>({symbol:c.symbol,name:c.name,score:finite(c.score),reason:c.reason??null}))});
  evidence.points=evidence.points.slice(-15000);evidence.analyses=evidence.analyses.slice(-120);
  const keys=Object.keys(state.reviewEvidence).sort();for(const key of keys.slice(0,-3))delete state.reviewEvidence[key];
}
function closedTrips(trades){
  const active=new Map(),closed=[];
  for(const t of [...trades].sort((a,b)=>a.time-b.time||Number(a.id)-Number(b.id))){
    if(t.side==='BUY'){const p=active.get(t.symbol)??{symbol:t.symbol,quantity:0,realized:0,openedAt:t.time,closedAt:null};p.quantity+=t.quantity;active.set(t.symbol,p);}
    else {const p=active.get(t.symbol);if(!p)continue;p.quantity-=t.quantity;p.realized+=Number(t.realized)||0;if(p.quantity<=0){p.closedAt=t.time;closed.push(p);active.delete(t.symbol);}}
  }return closed;
}
function adaptation(state,market,date,trades){
  const before=strategyPolicy(state),after={...before},reasons=[],all=closedTrips(state.trades.filter(t=>marketDate(t.time,market)<=date)).slice(-20);
  const days=new Set(all.map(t=>marketDate(t.closedAt,market))),today=all.filter(t=>marketDate(t.closedAt,market)===date),net=sum(all,t=>t.realized),losses=all.filter(t=>t.realized<0).length;
  const enough=all.length>=5&&days.size>=2&&today.length>0;
  if(enough&&net<0&&losses/all.length>=.6&&before.minimumMomentumPct<.6){after.minimumMomentumPct=Math.min(.6,Math.round((before.minimumMomentumPct+.05)*100)/100);reasons.push('최근 최대 20회 완결 매매에서 순손실·손실 비율 60% 이상: 진입 상승세 기준을 0.05%p 강화');}
  const buyRows=state.trades.filter(t=>t.side==='BUY'&&marketDate(t.time,market)<=date&&t.costs).slice(-100);
  const orders=new Set(buyRows.map(t=>t.orderId??t.id)),buyDays=new Set(buyRows.map(t=>marketDate(t.time,market)));
  const slippage=sum(buyRows,t=>Math.max(0,t.costs.slippage))/Math.max(1,sum(buyRows,t=>t.amount));
  if(trades.some(t=>t.side==='BUY')&&orders.size>=5&&buyDays.size>=2&&slippage>.0015&&before.maximumSpreadPct>.25){after.maximumSpreadPct=Math.max(.25,Math.round((before.maximumSpreadPct-.05)*100)/100);reasons.push('여러 거래일의 매수 주문 5건 이상에서 불리한 체결 가격차가 거래금액의 0.15% 초과: 호가 간격 허용치를 0.05%p 축소');}
  if(!reasons.length)reasons.push(!enough?'완결 매매·거래일 표본이 부족하거나 새 완결 매매가 없어 기존 전략 유지':'변경 조건을 충족하지 않아 기존 전략 유지');
  const changed=Object.keys(before).some(k=>before[k]!==after[k]);
  return {changed,before,after,reasons,sample:{completedTrips:all.length,distinctDays:days.size,todayCompletedTrips:today.length,netRealized:net,lossRatio:all.length?losses/all.length:null,adverseSlippagePct:slippage*100},status:changed?'scheduled':'maintained',
    limits:'회당 최대 0.05%p, 진입 상승세 0.15~0.60%, 호가 간격 0.25~0.65%. 손절·익절·비중·수수료는 자동 변경하지 않음. 수익 개선을 보장하는 최적화가 아님.'};
}
function decision(state,t,market,date){
  const points=(state.reviewEvidence?.[date]?.points??[]).filter(p=>p.symbol===t.symbol&&p.time>=t.time+5*60000&&p.time<=t.time+7*60000).sort((a,b)=>a.time-b.time);
  const later=points[0],price=market==='US'?t.priceUsd:t.price,rate=market==='US'?t.fxRate:1;
  const alternative=later&&Number.isFinite(price)&&Number.isFinite(rate)?{time:later.time,price:later.price,grossDifferenceKrw:Math.round((t.side==='BUY'?price-later.price:later.price-price)*t.quantity*rate),
    text:'5분 뒤 관측 시세와의 가격차 참고액. 같은 수량·체결 당시 환율을 고정한 사후 비교이며 호가·체결 가능성·추가 비용을 재현한 수익이 아닙니다.'}:null;
  const order=(state.paperOrders??[]).find(o=>o.id===t.orderId);
  return {id:t.id,time:t.time,symbol:t.symbol,name:t.name,side:t.side,quantity:t.quantity,price,amount:t.amount,cashAmount:t.cashAmount??t.amount,realized:t.realized??0,costs:t.costs??null,reason:t.reason??'당시 판단 이유가 저장되지 않았습니다.',source:t.source??'batch',strategyVersion:t.strategyVersion??'이전 방식',
    orderEvidence:order?{createdAt:order.createdAt,reference:order.reference,limitPrice:order.limitPrice,status:order.status,note:order.note}:null,
    alternative,alternativeNote:alternative?null:'해당 종목의 5~7분 뒤 시세가 저장되지 않아 기다렸을 때의 결과를 비교할 수 없습니다.'};
}
function buildReport(state,market,date,now){
  const trades=state.trades.filter(t=>marketDate(t.time,market)===date),daily=(state.daily??[]).find(d=>d.date===date),prior=(state.daily??[]).filter(d=>d.date<date).sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
  const equityPnl=daily?daily.close-(prior?.close??daily.open):null,realized=sum(trades.filter(t=>t.side==='SELL'),t=>t.realized),costs=sum(trades,t=>t.costs? t.costs.commission+t.costs.transactionTax+t.costs.fxSpread:0);
  const sells=trades.filter(t=>t.side==='SELL'),scans=state.scans.filter(s=>marketDate(s.time,market)===date),decisions=trades.map(t=>decision(state,t,market,date));
  const reasons={};for(const t of sells){const category=/손절/.test(t.reason)?'손절':/익절/.test(t.reason)?'익절':/장중|뉴스|공시/.test(t.reason)?'뉴스·공시':/추세/.test(t.reason)?'추세 약화':'기타';const r=reasons[category]??={count:0,realized:0};r.count++;r.realized+=t.realized??0;}
  const observations=(state.reviewEvidence?.[date]?.points??[]).length,session=state.reviewSessions?.[date],quality=[];
  if(!session)quality.push('과거 장 운영 일정이 보존되지 않아 날짜가 지난 거래기록으로 마감 여부를 판단했습니다.');
  if(trades.some(t=>!t.costs))quality.push('일부 이전 거래에는 비용 상세가 저장되지 않았습니다. 표시된 비용 합계는 기록된 항목만 포함합니다.');
  if(!observations)quality.push('기능 추가 이전의 장중 시세 경로가 없어 사후 대안 비교에 한계가 있습니다.');
  if(session&&(!state.reviewCloseQuality?.[date]||state.reviewCloseQuality[date].missingSymbols.length))quality.push('일부 또는 전체 종목의 마감 시세를 별도로 확인하지 못해 마지막 저장 평가금액이 포함됩니다.');
  if(state.operations?.status==='error')quality.push('복기 작성 시점에 감시/API 오류 기록이 있어 마감 평가 자료가 불완전할 수 있습니다.');
  if(scans.some(s=>s.status==='error'))quality.push('해당 날짜에 분석 실패가 있어 모든 기회를 검토했다고 볼 수 없습니다.');
  const adaptive=adaptation(state,market,date,trades);
  const alternatives=decisions.filter(d=>d.alternative),favorable=alternatives.filter(d=>d.alternative.grossDifferenceKrw>0).length;
  const findings=[...(alternatives.length?[`5분 대안 비교가 가능한 ${alternatives.length}건 중 ${favorable}건은 대기 후 관측가가 가격상 유리했습니다. 실제 대안 체결 수익을 입증하지는 않습니다.`]:[]),...Object.entries(reasons).map(([reason,r])=>`${reason} 매도 ${r.count}회 체결의 순실현손익은 ${Math.round(r.realized).toLocaleString('ko-KR')}원입니다.`)];
  return {date,market,createdAt:now,status:'final',sessionEnd:session?.end??null,summary:{equityPnl,realized,explicitCosts:costs,fillCount:trades.length,buyCount:trades.filter(t=>t.side==='BUY').length,sellCount:sells.length,winningSells:sells.filter(t=>t.realized>0).length,endingEquity:daily?.close??null},
    overview:trades.length?'저장된 판단 이유와 실제 모의 체결을 기준으로 매매를 재구성했습니다. 평가손익과 실현손익은 다르며 부분 체결은 별도 건수로 집계합니다.':'기록된 체결이 없는 날입니다. 무거래만으로 전략이 좋거나 나빴다고 판단하지 않습니다.',
    decisions,exitReasons:reasons,analysis:{success:scans.filter(s=>s.status!=='error').length,failed:scans.filter(s=>s.status==='error').length},
    alternatives:decisions.some(d=>d.alternative)?'일부 거래는 5분 후 관측 시세와 비교할 수 있습니다. 사후 더 유리한 시세가 보였더라도 당시 예측하거나 체결할 수 있었다는 뜻은 아닙니다.':'대안 결과를 뒷받침할 시세가 부족합니다. 앞으로 저장되는 관측자료로 기다리는 선택을 비교합니다.',
    lessons:[...findings,...(costs>0?['수수료·거래세·환전 비용을 포함한 순손익으로 평가합니다.']:[]),...(Object.keys(reasons).length?['매도 이유별 실현손익을 비교하되 부분 체결 수를 독립 전략 표본으로 간주하지 않습니다.']:[]),...adaptive.reasons],
    quality,adaptive,method:'저장된 체결·주문·분석·관측 시세로 만든 규칙 기반 복기입니다. 기사 전문 AI 분석이나 실행 가능한 대안 전략의 백테스트가 아닙니다.'};
}
export function syncDailyReviews(state,market,now,{pastOnly=false}={}){
  rememberSession(state,market);state.reviews??={};const today=marketDate(now,market);
  const dates=[...new Set([...state.trades.map(t=>marketDate(t.time,market)),...(state.daily??[]).map(d=>d.date)])].filter(Boolean).sort();
  for(const date of dates){if(state.reviews[date]||date>today||(pastOnly&&date===today))continue;
    const session=state.reviewSessions?.[date];if(date===today&&(!session||now<session.end+60000))continue;
    const active=state.trades.some(t=>marketDate(t.time,market)===date)||state.scans.some(s=>marketDate(s.time,market)===date)||(session&&(state.daily??[]).some(d=>d.date===date&&d.time>=session.start));
    if(!active)continue;const report=buildReport(state,market,date,now);state.reviews[date]=report;
    // Only the newest completed day may schedule a future change; old backfills cannot overwrite a newer decision.
    state.dailyPolicy??={current:strategyPolicy(state),pending:null,applied:[],lastReviewed:null};
    if(!state.dailyPolicy.lastReviewed||date>state.dailyPolicy.lastReviewed){state.dailyPolicy.lastReviewed=date;
      state.dailyPolicy.pending=report.adaptive.changed?{sourceDate:date,before:report.adaptive.before,after:report.adaptive.after,reasons:report.adaptive.reasons}:null;}
  }
}
export function reviewCalendar(state,market,now){
  const today=marketDate(now,market),dates=[...new Set([...(state.daily??[]).map(d=>d.date),...state.trades.map(t=>marketDate(t.time,market)),...Object.keys(state.reviews??{})])].sort();
  return {market,today,policy:strategyPolicy(state),pending:state.dailyPolicy?.pending??null,applied:(state.dailyPolicy?.applied??[]).slice(-10),days:dates.map(date=>{
    const report=state.reviews?.[date],daily=(state.daily??[]).find(d=>d.date===date),prior=(state.daily??[]).filter(d=>d.date<date).sort((a,b)=>a.date.localeCompare(b.date)).at(-1),trades=state.trades.filter(t=>marketDate(t.time,market)===date);
    return {date,status:report?'final':date===today?'pending':'unavailable',equityPnl:report?.summary.equityPnl??(daily?daily.close-(prior?.close??daily.open):null),realized:report?.summary.realized??sum(trades.filter(t=>t.side==='SELL'),t=>t.realized),fillCount:trades.length,changed:report?.adaptive.changed??false};})};
}
