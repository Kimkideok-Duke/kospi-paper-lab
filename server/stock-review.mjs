import {dayChartAnalysis,dayChartSummary} from './day-chart-review.mjs';
const total = (rows, pick) => rows.reduce((n,r)=>n+(Number(pick(r))||0),0);
function reasons(rows) {
  const groups=new Map();
  for(const t of rows){const text=t.reason||'당시 판단 이유 미저장',g=groups.get(text)??{text,fills:0,quantity:0};g.fills++;g.quantity+=t.quantity;groups.set(text,g);}
  return [...groups.values()].sort((a,b)=>b.quantity-a.quantity);
}

// Build a read-only view of old and new reports; never rewrite their strategy decisions.
export function stockReview(report,chartAudit=null,rawTrades=[]) {
  if(!report)return null;
  const grouped=new Map();
  for(const t of report.decisions??[]){const rows=grouped.get(t.symbol)??[];rows.push(t);grouped.set(t.symbol,rows);}
  const stocks=[...grouped].map(([symbol,rows])=>{
    rows.sort((a,b)=>a.time-b.time);
    const buys=rows.filter(t=>t.side==='BUY'),sells=rows.filter(t=>t.side==='SELL');
    const explicitCosts=total(rows,t=>t.costs?total([t.costs.commission,t.costs.transactionTax,t.costs.fxSpread],v=>v):0);
    const compared=rows.filter(t=>t.alternative),favorable=compared.filter(t=>t.alternative.grossDifferenceKrw>0);
    const realized=total(sells,t=>t.realized),buyReasons=reasons(buys),sellReasons=reasons(sells);
    const improvements=[],dayChart=dayChartAnalysis(rows,chartAudit?.records?.[symbol],report.market,rawTrades);
    const chartAvailable=dayChart.analyses.some(a=>a.barCount>0);
    for(const [side,label] of [['BUY','매수'],['SELL','매도']]){
      const sample=compared.filter(t=>t.side===side&&t.price>0&&t.quantity>0&&t.alternative.price>0);
      if(!sample.length)continue;
      const quantity=total(sample,t=>t.quantity),change=total(sample,t=>(t.alternative.price/t.price-1)*100*t.quantity)/quantity;
      const better=side==='BUY'?change<0:change>0;
      improvements.push(`${label} ${sample.length}건의 5~7분 뒤 관측가는 체결가보다 수량 가중 평균 ${Math.abs(change).toFixed(2)}% ${change<0?'낮':'높'}았습니다. 이 비교 범위에서는 ${better?'기다리는 선택이 가격상 유리했':'즉시 체결 가격이 같거나 유리했'}습니다. 사후 관측 비교이며 같은 호가·수량의 체결을 보장하지 않습니다.`);
    }
    if(compared.length)improvements.push(`5~7분 뒤 관측가를 비교할 수 있는 체결 ${compared.length}건 중 ${favorable.length}건은 기다린 가격이 유리했습니다. ${rows.length-compared.length}건은 비교 자료가 없습니다. 부분 체결은 독립된 매매 기회가 아니며, 가격차를 합쳐 대안 수익으로 계산하지 않습니다.`);
    else improvements.push(chartAvailable?'당시 저장한 5~7분 관측값은 없지만, 아래 마감 후 조회한 하루 분봉으로 사후 판단을 보완했습니다.':'체결 후 5~7분 관측값이 없습니다. 마감 후 하루 분봉 확인·재조회 상태를 아래에서 확인할 수 있습니다. 현재 자료만으로 결과를 확인할 수 없습니다.');
    if(realized<0)improvements.push('당일 매도 체결의 실현손익이 손실입니다. 당시 진입·청산 근거를 함께 검토해야 합니다. 손절을 늦추거나 더 빨리 청산했을 때 나았는지는 별도 시세·호가 비교가 필요합니다.');
    if(explicitCosts>0)improvements.push(`기록된 명시 비용은 ${Math.round(explicitCosts).toLocaleString('ko-KR')}원입니다. 재진입·분할 체결 횟수와 주문 수를 구분해 비용 부담을 검토해야 합니다.`);
    if(!sells.length)improvements.push('당일 매도가 없어 실현손익으로 진입의 성패를 판단할 수 없습니다.');
    return {symbol,name:rows.at(-1).name,chartTradeId:String(rows[0].id),date:report.date,fillCount:rows.length,buyCount:buys.length,sellCount:sells.length,
      buyQuantity:total(buys,t=>t.quantity),sellQuantity:total(sells,t=>t.quantity),realized,explicitCosts,
      missingCostFills:rows.filter(t=>!t.costs).length,buyReasons,sellReasons,
      motivation:buys.length?'기록된 매수 판단은 '+buyReasons.slice(0,3).map(r=>r.text).join(' / '):'당일 신규 매수 없이 이전 보유분을 매도했습니다. 이전 진입 이유를 오늘의 매수 판단으로 간주하지 않습니다.',
      outcome:`하루 ${rows.length}건의 체결(매수 ${buys.length} / 매도 ${sells.length})을 종합했습니다. 매도 실현손익은 ${Math.round(realized).toLocaleString('ko-KR')}원입니다. 이전 매수분의 손익이 포함될 수 있으며, 남은 보유분의 평가손익과는 다릅니다.`,
      improvements,dayChart,comparison:{available:compared.length,favorable:favorable.length,missing:rows.length-compared.length}};
  });
  const supplement=dayChartSummary(chartAudit),hasChart=stocks.some(s=>s.dayChart.coverage.bars>0);
  return {...report,stocks,dayChartReview:supplement,...(hasChart?{
    alternatives:'당시 저장한 관측 비교와 별도로 마감 후 해당 거래일의 정규장 1분봉을 조회해 판단을 보완했습니다. 종목별 5·15·30분 뒤 가격, 매도 후 고가·저가와 마지막 분봉을 비교합니다. 확인되지 않은 구간은 최선의 시점으로 단정하지 않습니다.',
    method:(report.method??'저장된 거래기록 기반 복기입니다.')+' 마감 후 조회한 분봉은 당시 판단과 분리된 사후 보완 자료이며 기존 전략 보완안과 원본 보고서는 변경하지 않습니다.'}:{} )};
}
