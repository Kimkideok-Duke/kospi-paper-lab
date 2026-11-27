import {marketDate} from './strategy-policy.mjs';
import {closingSession} from './closing-audit.mjs';
import {loadChartCandles} from './chart-candles.mjs';
const MINUTE=60000;
export const DAY_CHART_VERSION=1;
const positive=v=>Number.isFinite(v)&&v>0;

// Background maintenance only: shared read transport, tenant-private storage, no order execution.
export async function collectDayCharts(state,market,client,scope,now,{budget=6,maxSymbols=2,date:targetDate=null}={}){
  state.reviewDayCharts??={};let requests=0,processed=0;
  const dates=[...new Set(state.trades.map(t=>marketDate(t.time,market)))].filter(d=>d&&d<=marketDate(now,market)&&(!targetDate||d===targetDate)).sort().reverse();
  const reads={async get(path,params){if(requests>=budget)throw Error('day-chart-budget');requests++;return client.get(path,params);}};
  for(const date of dates){
    if(requests>=budget||processed>=maxSymbols)break;
    let session=state.reviewSessions?.[date];
    if(!session||!Number.isFinite(session.start)||!Number.isFinite(session.end)){
      const old=state.reviewDayCharts[date];if((old?.nextAttempt??0)>now)continue;
      try{const cal=await reads.get('market-calendar/'+market,{date});session=cal?.today?.date===date?closingSession(cal.today,market):null;
        if(!session)throw Error('missing-session');state.reviewSessions??={};state.reviewSessions[date]=session;
      }catch{state.reviewDayCharts[date]={...old,date,market,status:'partial',records:old?.records??{},nextAttempt:now+300000,reason:'해당 거래일 장 일정 확인 대기'};continue;}
    }
    if(session.end<=session.start||session.end-session.start>24*3600000||now<session.end+MINUTE)continue;
    const symbols=[...new Map(state.trades.filter(t=>marketDate(t.time,market)===date).map(t=>[t.symbol,{symbol:t.symbol,name:t.name}])).values()];
    const prior=state.reviewDayCharts[date];
    const audit=state.reviewDayCharts[date]={...prior,version:DAY_CHART_VERSION,date,market,source:'Toss /candles 1m adjusted=false · 정규장 · 봉 종료 시각',
      session:{start:session.start,end:session.end},targets:symbols,records:prior?.records??{},reason:null};
    for(const target of symbols){
      if(requests>=budget||processed>=maxSymbols)break;
      const old=audit.records[target.symbol];
      if(old?.status==='confirmed'&&old.version===DAY_CHART_VERSION&&old.start===session.start&&old.end===session.end)continue;
      if((old?.nextAttempt??0)>now)continue;
      processed++;
      const series=await loadChartCandles(scope,reads,{market,symbol:target.symbol,date,currency:market==='US'?'USD':'KRW',trades:[],session:audit.session},now);
      const candles=series.candles.filter(c=>c.time>session.start&&c.time<=session.end);
      const confirmed=series.status==='complete'&&candles.length>0,attempts=(old?.attempts??0)+1;
      const keep=(!confirmed&&(old?.candles?.length??0)>candles.length)?old.candles:candles;
      audit.records[target.symbol]={...target,version:DAY_CHART_VERSION,start:session.start,end:session.end,status:confirmed?'confirmed':keep.length?'partial':'retry',
        candles:keep,checkedAt:now,attempts,pages:series.pages,invalid:series.invalid,nextAttempt:confirmed?null:now+Math.min(3600000,60000*2**Math.min(attempts-1,6)),
        reason:confirmed?null:'당일 분봉 일부 또는 전체 확인 실패 · 한도를 지키며 재조회 예정'};
      audit.revision=(audit.revision??0)+1;
    }
    audit.confirmed=symbols.filter(t=>audit.records[t.symbol]?.status==='confirmed').length;
    audit.status=audit.confirmed===symbols.length?'complete':'partial';audit.checkedAt=now;
  }
  return {requests,processed};
}

const pct=(a,b)=>(a/b-1)*100;
function coverage(record){
  const candles=record?.candles??[];if(!candles.length)return {bars:0,gaps:0,closingGapMinutes:null};
  let gaps=0;for(let i=1;i<candles.length;i++)if(candles[i].time-candles[i-1].time>3*MINUTE)gaps++;
  return {bars:candles.length,gaps,openingGapMinutes:Math.max(0,(candles[0].time-record.start)/MINUTE-1),closingGapMinutes:Math.max(0,(record.end-candles.at(-1).time)/MINUTE)};
}
export function dayChartAnalysis(rows,record,market,rawTrades=[]){
  const native=t=>market==='US'?t.priceUsd:t.price;
  const raw=new Map(rawTrades.map(t=>[String(t.id),t]));
  const candles=(record?.candles??[]).filter(c=>Number.isFinite(c.time)&&c.time>record.start&&c.time<=record.end&&[c.open,c.high,c.low,c.close].every(positive)).sort((a,b)=>a.time-b.time);
  const analyses=rows.map(t=>{
    const original=raw.get(String(t.id)),price=positive(t.price)?t.price:native(original??{}),fx=market==='KR'?1:original?.fxRate;
    // Provider timestamps are minute END times. Exclude the bar straddling a fill.
    const after=candles.filter(c=>c.time-MINUTE>=t.time),last=after.at(-1);
    const compare=(p,time)=>positive(price)&&positive(p)?{time,price:p,changePct:pct(p,price),differenceKrw:positive(fx)&&positive(t.quantity)?Math.round((t.side==='BUY'?price-p:p-price)*t.quantity*fx):null}:null;
    const checkpoints=[5,15,30].map(minutes=>{const target=t.time+minutes*MINUTE,c=after.find(c=>c.time>=target&&c.time<=target+3*MINUTE);return {minutes,...(c?compare(c.close,c.time):{}),available:!!c};});
    const high=after.reduce((a,c)=>!a||c.high>a.high?c:a,null),low=after.reduce((a,c)=>!a||c.low<a.low?c:a,null);
    const result={id:String(t.id),time:t.time,side:t.side,quantity:t.quantity,price,reason:t.reason,checkpoints,
      high:high?compare(high.high,high.time):null,low:low?compare(low.low,low.time):null,last:last?compare(last.close,last.time):null,
      barCount:after.length,judgement:'',suggestion:''};
    if(!last||!positive(price)){result.judgement='체결 뒤 완전히 끝난 분봉이 없어 비교를 보류합니다. 마감 직전 매매 또는 자료 누락일 수 있습니다.';return result;}
    const later15=checkpoints.find(p=>p.minutes===15&&p.available),late=last.close/price-1;
    if(t.side==='SELL'){
      const up=pct(high.high,price),down=pct(low.low,price),risk=/손절|추세|악재|뉴스|공시|보호/.test(t.reason??'');
      result.judgement=`매도 뒤 확인된 봉의 고가는 체결가 대비 ${up.toFixed(2)}%, 저가는 ${down.toFixed(2)}%, 마지막 분봉 종가는 ${(late*100).toFixed(2)}%였습니다.`;
      if(low.time<high.time&&down<-.5&&up>.5)result.judgement+=' 추가 하락 뒤 반등한 경로가 있어 반등만으로 당시 위험 대응이 잘못됐다고 단정할 수 없습니다.';
      if(up>1&&(later15?.changePct>.5||late>.005))result.suggestion=risk?'반등 이후 가격은 더 유리했지만 손절·보호 규칙을 사후 가격으로 무효화하지 않습니다. 다음 검증에서는 반등 확인 후 재진입 조건이나 분할 청산을 비교할 수 있습니다.':'후속 관측 가격이 더 높게 유지됐습니다. 다음 검증에서 일부 수량의 15분 추가 보유 또는 분할 익절을 비교할 여지가 있습니다.';
      else if(down<-1&&late<=0)result.suggestion='매도 이후의 추가 하락 노출을 줄인 결과입니다. 이 자료 범위에서는 청산 유지가 가격상 방어적이었으며, 더 기다리는 선택의 우위는 확인되지 않습니다.';
      else result.suggestion='확인된 가격 경로만으로 기존 청산보다 일관되게 유리한 선택을 확인하지 못했습니다. 기존 위험 기준을 유지하며 다음 표본을 비교합니다.';
    }else{
      result.judgement=`매수 뒤 마지막 확인 분봉 종가는 체결가 대비 ${(late*100).toFixed(2)}%였습니다.`;
      result.suggestion=low.low<price*.995?'매수 이후 더 낮은 가격이 관측됐습니다. 다음 검증에서 눌림 지정가 진입을 비교할 수 있으나 당시 주문의 체결 여부와 추세 유지 조건을 함께 확인해야 합니다.':'확인된 경로에서는 더 낮은 진입 가격의 우위가 뚜렷하지 않습니다. 단기 상승 추격 비용과 진입 조건을 함께 검토합니다.';
    }
    return result;
  });
  return {status:record?.status??'waiting',checkedAt:record?.checkedAt??null,source:'토스 정규장 1분봉 · 수정주가 미적용 · 종료 시각',coverage:coverage({...record,candles}),analyses,
    note:'마감 후 조회한 사후 자료입니다. 고가·저가는 봉 내부 시점과 순서가 불명확한 가격 상한 참고치이며 실현 가능한 최적 매매가 아닙니다. 비교액은 체결 수량·당시 환율을 고정한 가격차로 추가 비용·호가·재진입을 재현하지 않으며 합산 수익으로 해석하지 않습니다. 마지막 분봉은 공식 종가와 다를 수 있습니다.'};
}
export function dayChartSummary(audit){return audit?{status:audit.status,revision:audit.revision??0,confirmed:audit.confirmed??0,total:audit.targets?.length??0,checkedAt:audit.checkedAt??null,session:audit.session,reason:audit.reason}:null;}
