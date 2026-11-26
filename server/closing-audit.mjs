import { INITIAL } from './engine.mjs';
import { marketDate } from './strategy-policy.mjs';

export function closingSession(day, market) {
  const regular = market === 'US' ? day?.regularMarket : day?.integrated?.regularMarket;
  const start = Date.parse(regular?.startTime), end = Date.parse(regular?.endTime);
  const after = market === 'KR' ? Date.parse(day?.integrated?.afterMarket?.endTime) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { date: day.date, start, end, closingEnd: Number.isFinite(after) ? Math.max(end, after) : end, closingSessionVersion: 1 };
}

export function closingTargets(state, market, date, session, now=Date.now()) {
  const holdings = new Map(), targets = new Map();
  let cash = INITIAL, ledgerComplete = true;
  for (const t of [...state.trades].sort((a,b) => a.time-b.time || Number(a.id)-Number(b.id))) {
    if (!Number.isFinite(t.time) || t.time > session.end) continue;
    const amount = t.cashAmount ?? t.amount;
    if (Number.isFinite(amount)) cash += t.side === 'BUY' ? -amount : amount; else ledgerComplete=false;
    const row = holdings.get(t.symbol) ?? { symbol: t.symbol, name: t.name, quantity: 0 };
    row.quantity += (t.side === 'BUY' ? 1 : -1) * t.quantity; holdings.set(t.symbol,row);
    if (marketDate(t.time,market) === date) targets.set(t.symbol,row);
  }
  for (const row of holdings.values()) { if (row.quantity > 0) targets.set(row.symbol,row); if (row.quantity<0) ledgerComplete=false; }
  // Imported holdings without a corresponding fill history cannot be valued as a verified ledger.
  if (marketDate(session.end,market) === marketDate(now,market)) for (const p of state.positions ?? []) {
    if (!holdings.has(p.symbol)) { targets.set(p.symbol,{symbol:p.symbol,name:p.name,quantity:p.quantity}); ledgerComplete=false; }
  }
  return { cash, ledgerComplete, targets: [...targets.values()].map(t=>({...t,quantity:Math.max(0,t.quantity)})) };
}

function closingFx(state,date,end) {
  const candidates = [
    ...(state.reviewEvidence?.[date]?.points ?? []).map(p=>({time:p.time,rate:p.fx})),
    ...(state.history ?? []).map(p=>({time:p.time,rate:p.fxRate})),
    ...(state.trades ?? []).map(t=>({time:t.time,rate:t.fxRate})),
    {time:state.fx?.from,rate:state.fx?.rate},
  ].filter(p=>Number.isFinite(p.time)&&p.time<=end&&p.time>=end-24*3600000&&Number.isFinite(p.rate)&&p.rate>0);
  return candidates.sort((a,b)=>b.time-a.time)[0] ?? null;
}

export async function collectClosingAudits(state,market,client,now,{budget=8}={}) {
  state.reviewCloseAudits ??= {};
  const dates=[...new Set([...Object.keys(state.reviews??{}),...Object.keys(state.reviewSessions??{}),...state.trades.map(t=>marketDate(t.time,market))])].filter(d=>d&&d<=marketDate(now,market)).sort().reverse();
  let requests=0;
  for (const date of dates) {
    let audit=state.reviewCloseAudits[date];
    if (audit?.status==='complete' || (audit?.nextAttempt??0)>now) continue;
    if (requests>=budget) break;
    let session=state.reviewSessions?.[date];
    if (session?.end>now) continue;
    if (!session?.closingSessionVersion) {
      requests++;
      try {
        const calendar=await client.get('market-calendar/'+market,{date});
        session=calendar?.today?.date===date?closingSession(calendar.today,market):null;
        if (!session) throw new Error('missing-session');
        state.reviewSessions??={};state.reviewSessions[date]={...state.reviewSessions[date],...session};
      } catch {
        state.reviewCloseAudits[date]={...audit,date,market,status:'partial',records:audit?.records??{},nextAttempt:now+300000,sessionError:'해당 거래일의 장 운영 일정 확인 대기'};
        continue;
      }
    }
    const context=closingTargets(state,market,date,session,now);
    const eligibleAt=session.closingEnd+60000;
    audit=state.reviewCloseAudits[date]={...audit,date,market,version:1,basis:market==='KR'?'KRX_NXT_DAILY':'US_REGULAR_DAILY',
      eligibleAt,targets:context.targets,cash:context.cash,ledgerComplete:context.ledgerComplete,records:audit?.records??{},sessionError:null,status:'waiting',nextAttempt:eligibleAt};
    if (now<eligibleAt) continue;
    audit.status='checking';audit.nextAttempt=now+60000;
    for (const target of audit.targets) {
      const existing=audit.records[target.symbol];
      if (existing?.status==='confirmed'||(existing?.nextAttempt??0)>now||requests>=budget) continue;
      requests++;
      try {
        const page=await client.get('candles',{symbol:target.symbol,interval:'1d',count:5,before:date+'T23:59:59.999Z',adjusted:false});
        const candle=(page?.candles??[]).find(c=>String(c.timestamp).slice(0,10)===date&&c.currency===(market==='KR'?'KRW':'USD')&&Number.isFinite(Number(c.closePrice))&&Number(c.closePrice)>0);
        if (!candle) throw new Error('missing-close');
        audit.records[target.symbol]={symbol:target.symbol,name:target.name,status:'confirmed',price:Number(candle.closePrice),candleTime:candle.timestamp,checkedAt:now,source:'Toss /candles 1d adjusted=false'};
      } catch (error) {
        const attempts=(existing?.attempts??0)+1;
        audit.records[target.symbol]={symbol:target.symbol,name:target.name,status:'retry',attempts,checkedAt:now,nextAttempt:now+Math.min(3600000,60000*2**Math.min(attempts-1,6)),reason:error.status===429?'호출 한도 대기':'해당 거래일 종가 확인 실패 · 재조회 예정'};
      }
    }
    const missing=audit.targets.filter(t=>audit.records[t.symbol]?.status!=='confirmed');
    audit.confirmed=audit.targets.length-missing.length;audit.missingSymbols=missing.map(t=>t.symbol);audit.status=missing.length?'partial':'complete';
    audit.revision=(audit.revision??0)+1;
    if (audit.status==='complete') {
      audit.completedAt=now;
      const fx=market==='KR'?{rate:1,time:session.end}:closingFx(state,date,session.end);
      const hasHoldings=audit.targets.some(t=>t.quantity>0);
      audit.fx=fx;
      audit.valuationStatus=!audit.ledgerComplete?'missing-ledger':!fx&&hasHoldings?'missing-fx':'complete';
      if (audit.valuationStatus==='complete') audit.equity=audit.cash+audit.targets.reduce((sum,t)=>sum+Math.floor(t.quantity*audit.records[t.symbol].price*(fx?.rate??1)+1e-7),0);
    }
  }
  return {requests};
}

const oldCloseNote='일부 또는 전체 종목의 마감 시세를 별도로 확인하지 못해 마지막 저장 평가금액이 포함됩니다.';
export function closingReview(state,report) {
  if (!report) return null;
  const audit=state.reviewCloseAudits?.[report.date];
  if (!audit) return report;
  const result={...report,summary:{...report.summary},quality:report.quality.filter(v=>v!==oldCloseNote),closingAudit:audit};
  const count=audit.targets?.length??0,confirmed=audit.targets?.filter(t=>audit.records[t.symbol]?.status==='confirmed').length??0;
  if (audit.status!=='complete') result.quality.push(audit.status==='waiting'?'통합 시간외장 종료 후 종가 확정을 기다리고 있습니다.':'종가 별도 확인 '+confirmed+'/'+count+'종목 · 미확인 종목은 재조회합니다.');
  else if (audit.valuationStatus!=='complete') result.quality.push('전 종목 종가는 확인했지만 '+(audit.valuationStatus==='missing-fx'?'마감 이전 저장 환율':'과거 원장 정보')+'이 부족해 기존 평가금액을 표시합니다.');
  else {
    const prior=[...new Set([...Object.keys(state.reviews??{}),...(state.daily??[]).map(d=>d.date)])].filter(d=>d<report.date).sort().at(-1);
    const priorAudit=prior?state.reviewCloseAudits[prior]:null;
    const daily=(state.daily??[]).find(d=>d.date===report.date);
    result.summary.regularEquityPnl=report.summary.equityPnl;result.summary.regularEndingEquity=report.summary.endingEquity;
    result.summary.endingEquity=audit.equity;
    result.summary.equityPnl=prior&&priorAudit?.valuationStatus!=='complete'?null:audit.equity-(prior?priorAudit.equity:daily?.open??INITIAL);
    if (result.summary.equityPnl===null) result.quality.push('전 거래일의 종가 기준 평가 확인을 기다리고 있어 당일 평가손익은 아직 계산하지 않습니다.');
  }
  return result;
}
