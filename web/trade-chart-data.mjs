// API minute timestamps are bar ends; chart bars use their actual interval starts.
export function chartCandles(candles, minutes=1){
  const width=minutes*60000,groups=new Map();
  for(const c of [...candles].sort((a,b)=>a.time-b.time)){
    const time=Math.floor((c.time-60000)/width)*width/1000;
    const bar=groups.get(time);
    if(bar){bar.high=Math.max(bar.high,c.high);bar.low=Math.min(bar.low,c.low);bar.close=c.close;bar.volume+=c.volume;}
    else groups.set(time,{time,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume});
  }
  return [...groups.values()];
}
export function originalChartUrl(market,symbol){
  return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent(market==='KR'?'KRX:'+symbol:symbol);
}
// Put fills on the containing candle, retaining actual time/price in their details.
// Group partial fills per candle and direction; the selected fill remains exact.
export function chartFills(fills,selectedId,minutes=1){
  const width=minutes*60000,groups=new Map(),rows=[];
  for(const t of fills){
    const markerTime=Math.floor(t.time/width)*width/1000;
    if(t.id===selectedId){rows.push({...t,markerTime,members:[t]});continue;}
    const key=t.side+':'+markerTime;
    const g=groups.get(key)??{id:'bar:'+key,side:t.side,time:t.time,markerTime,quantity:0,amount:0,members:[]};
    g.quantity+=t.quantity;g.amount+=t.quantity*t.price;g.members.push(t);groups.set(key,g);
  }
  for(const g of groups.values())rows.push(g.members.length===1?{...g.members[0],markerTime:g.markerTime,members:g.members}:{...g,price:g.amount/g.quantity});
  return rows.sort((a,b)=>a.markerTime-b.markerTime||Number(a.id===selectedId)-Number(b.id===selectedId));
}
