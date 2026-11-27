import {marketDate} from './strategy-policy.mjs';
const MINUTE=60000;
export function chartRange(chart,now){
  if(Number.isFinite(chart.session?.start)&&Number.isFinite(chart.session?.end)&&chart.session.end>chart.session.start){
    return {from:chart.session.start,until:Math.min(now,chart.session.end)};
  }
  if(chart.date){
    const midnight=Date.parse(chart.date+'T00:00:00Z');let from=midnight-14*3600000;
    while(marketDate(from,chart.market)<chart.date)from+=3600000;
    let until=from+3600000;while(marketDate(until,chart.market)===chart.date)until+=3600000;
    return {from,until:Math.min(now,until-1)};
  }
  const times=chart.trades.map(t=>t.time);
  return {from:Math.min(...times)-120*MINUTE,until:Math.min(now,chart.open===false?Math.max(...times)+30*MINUTE:now)};
}
export function normalizeCandle(c,currency){
  const time=Date.parse(c.timestamp),open=Number(c.openPrice),high=Number(c.highPrice),low=Number(c.lowPrice),close=Number(c.closePrice),volume=Number(c.volume);
  if(c.currency!==currency||!Number.isFinite(time)||![open,high,low,close].every(v=>Number.isFinite(v)&&v>0)||c.volume==null||c.volume===''||!Number.isFinite(volume)||volume<0||low>Math.min(open,close)||high<Math.max(open,close)||low>high)return null;
  return {time,open,high,low,close,volume};
}

// Tenant-scoped, bounded RAM cache. Concurrent popups share market-data work only.
export function createChartCandleLoader(){
  const scopes=new WeakMap();
  return async function load(scope,client,chart,now=Date.now()){
    let bucket=scopes.get(scope);if(!bucket){bucket=new Map();scopes.set(scope,bucket);}
    const {from,until}=chartRange(chart,now),end=Math.floor(until/MINUTE)*MINUTE;
    const key=[chart.market,chart.symbol,from,chart.date??end].join(':');
    const cached=bucket.get(key);if(cached&&now>=cached.time&&now-cached.time<cached.ttl)return structuredClone(await cached.task);
    const task=(async()=>{
      const candles=new Map();let before=new Date(end).toISOString(),complete=false,invalid=0,pages=0;
      try{
        while(pages<12){
          pages++;const page=await client.get('candles',{symbol:chart.symbol,interval:'1m',count:200,before,adjusted:false});
          if(!Array.isArray(page?.candles))throw Error('invalid-candles');
          const rawTimes=page.candles.map(c=>Date.parse(c.timestamp)).filter(Number.isFinite);
          for(const raw of page.candles){const c=normalizeCandle(raw,chart.currency);if(!c){invalid++;continue;}if(c.time>=from&&c.time<=end)candles.set(c.time,c);}
          const oldest=rawTimes.length?Math.min(...rawTimes):Infinity;
          if(oldest<=from||!page.nextBefore){complete=true;break;}
          if(!Number.isFinite(Date.parse(page.nextBefore))||Date.parse(page.nextBefore)>=Date.parse(before))break;
          before=page.nextBefore;
        }
        return {candles:[...candles.values()].sort((a,b)=>a.time-b.time),status:complete&&!invalid?'complete':'partial',pages,invalid,checkedAt:now,from,until};
      }catch{return {candles:[...candles.values()].sort((a,b)=>a.time-b.time),status:'unavailable',pages,invalid,checkedAt:now,from,until};}
    })();
    const entry={task,time:now,ttl:60000};bucket.delete(key);bucket.set(key,entry);
    while(bucket.size>32)bucket.delete(bucket.keys().next().value);
    const result=await task;if(result.status!=='complete')entry.ttl=15000;
    return structuredClone(result);
  };
}
export const loadChartCandles=createChartCandleLoader();
