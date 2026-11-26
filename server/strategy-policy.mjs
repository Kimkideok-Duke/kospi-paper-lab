export const POLICY_DEFAULTS=Object.freeze({minimumMomentumPct:.15,maximumSpreadPct:.65});
const formatters=Object.fromEntries(['KR','US'].map(m=>[m,new Intl.DateTimeFormat('en-CA',{timeZone:m==='US'?'America/New_York':'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'})]));
export function marketDate(time,market){if(!Number.isFinite(time))return null;const parts=Object.fromEntries(formatters[market].formatToParts(time).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
export function strategyPolicy(state){return {...POLICY_DEFAULTS,...state.dailyPolicy?.current};}
export function activateDailyPolicy(state,market,now){
  const pending=state.dailyPolicy?.pending;if(!pending||!state.paperModel)return false;
  const today=state.calendar?.result?.today,date=marketDate(now,market),regular=market==='US'?today?.regularMarket:today?.integrated?.regularMarket;
  const start=Date.parse(regular?.startTime),end=Date.parse(regular?.endTime);
  if(today?.date!==date||date<=pending.sourceDate||!Number.isFinite(start)||!Number.isFinite(end)||now<start-15*60000||now>=end)return false;
  state.dailyPolicy.current={...pending.after};state.dailyPolicy.pending=null;
  state.dailyPolicy.applied??=[];state.dailyPolicy.applied.push({reviewDate:pending.sourceDate,time:now,date,before:pending.before,after:pending.after,reasons:pending.reasons});
  state.dailyPolicy.applied=state.dailyPolicy.applied.slice(-120);
  for(const order of state.paperOrders??[])if(order.side==='BUY'&&['PENDING','PARTIAL_FILLED'].includes(order.status)){order.status='CANCELED';order.note='일별 복기 전략 적용';}
  const equity=state.cash+state.positions.reduce((n,p)=>n+(market==='US'?p.valueKrw:p.price*p.quantity),0);
  state.paperModel.version=state.paperModel.code+':'+(state.versions.length+1);
  state.versions.push({id:state.paperModel.version,time:now,baseline:equity,tradeCount:state.trades.length,config:{...state.paperModel.config},dailyPolicy:{...pending.after},reviewDate:pending.sourceDate,rules:'일별 복기 보완: '+pending.reasons.join(' · ')});
  return true;
}
