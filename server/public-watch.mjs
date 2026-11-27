import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const WATCH_LIMIT=20, WATCH_TTL=90000, WATCH_CACHE=15000;
const cookieName='marketlab_viewer';
const security={'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive','x-frame-options':'DENY'};
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const symbol=v=>typeof v==='string'&&/^[A-Z0-9.\-]{1,20}$/.test(v)?v:'—';
// These instrument labels are the only public free text. No reasons, errors or profile fields.
const instrument=v=>typeof v==='string'?v.replace(/[\x00-\x1f<>]/g,'').slice(0,80):'';
export function publicPortfolio(state,market){
  const positions=(state.positions??[]).slice(0,20).map(p=>({symbol:symbol(p.symbol),name:instrument(p.name),quantity:number(p.quantity),price:number(market==='US'?p.priceUsd:p.price),valueKrw:number(market==='US'?p.valueKrw:p.price*p.quantity)}));
  const value=positions.reduce((n,p)=>n+(p.valueKrw??0),0),cash=number(state.cash),total=cash==null?null:cash+value;
  return {market,currency:market==='US'?'USD':'KRW',initial:10000000,cash,total,pnl:total==null?null:total-10000000,positions,
    history:(state.history??[]).slice(-240).map(h=>({time:number(h.time),total:number(h.total)})),
    benchmarks:Object.values(state.benchmarks??{}).slice(0,4).map(b=>({symbol:symbol(b.symbol),name:instrument(b.name),since:number(b.since),time:number(b.time),strategyPct:number(b.strategyPct),returnPct:number(b.returnPct),
      points:(b.points??[]).slice(-500).map(p=>({time:number(p.time),strategyPct:number(p.strategyPct),benchmarkPct:number(p.benchmarkPct)}))})),
    trades:(state.trades??[]).filter(t=>['BUY','SELL'].includes(t.side)).slice(-5).reverse().map(t=>({time:number(t.time),symbol:symbol(t.symbol),name:instrument(t.name),side:t.side,quantity:number(t.quantity),price:number(market==='US'?t.priceUsd:t.price),realized:t.side==='SELL'?number(t.realized):null}))};
}

// Separate anonymous capability: never calls the private app, authenticates a user or sends an order.
export function createPublicWatch({db,now=Date.now}){
  const viewers=new Map(),files=new Map();let cache=null,inflight=null,bucket=40,last=now(),joins=20,joinLast=last;
  const json=(body,status=200,extra={})=>Response.json(body,{status,headers:{...security,...extra}});
  const fail=(message,status,retry=30)=>json({error:message},status,{'retry-after':String(retry)});
  const token=request=>(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  async function snapshot(at){
    if(cache&&at-cache.time<WATCH_CACHE)return cache.data;
    if(inflight)return inflight;
    inflight=(async()=>{
      const markets=[];
      for(const [table,market] of [['campaign','KR'],['us_campaign','US']]){
        const row=await db.prepare('SELECT state FROM '+table+' WHERE id=1').first();
        markets.push(publicPortfolio(row?JSON.parse(row.state):{cash:10000000},market));
      }
      const data={asOf:at,refreshSeconds:30,capacity:WATCH_LIMIT,markets};cache={time:at,data};return data;
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  return async function handle(request){
    const path=new URL(request.url).pathname;if(path!=='/watch'&&!path.startsWith('/watch/'))return null;
    const at=now();bucket=Math.min(40,bucket+Math.max(0,at-last)*.02);last=at;
    if(bucket<1)return fail('요청이 많습니다. 잠시 후 다시 접속해 주세요.',429,5);bucket--;
    for(const [id,v] of viewers)if(v.expires<=at)viewers.delete(id);
    if(['/watch','/watch/','/watch/watch.js','/watch/watch.css'].includes(path)){
      if(request.method!=='GET')return fail('관람 전용 화면입니다.',405);
      const name=path.endsWith('.js')?'watch.js':path.endsWith('.css')?'watch.css':'watch.html';
      if(!files.has(name))files.set(name,readFileSync(new URL('../web/'+name,import.meta.url),'utf8'));
      return new Response(files.get(name),{headers:{...security,'content-type':(name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html')+'; charset=utf-8'}});
    }
    if(path==='/watch/join'){
      if(request.method!=='POST')return fail('허용되지 않은 요청입니다.',405);
      if(request.headers.get('origin')!==new URL(request.url).origin)return fail('관람 화면에서 접속해 주세요.',403);
      const existing=token(request);let id=existing;
      if(!viewers.has(existing)){
        joins=Math.min(20,joins+Math.max(0,at-joinLast)/1000);joinLast=at;
        if(viewers.size>=WATCH_LIMIT)return fail('현재 관람 인원이 가득 찼습니다. 잠시 후 다시 접속해 주세요.',429);
        if(joins<1)return fail('접속 요청이 많습니다. 잠시 후 다시 시도해 주세요.',429);joins--;
        id=randomBytes(24).toString('hex');viewers.set(id,{expires:at+WATCH_TTL,lastRead:-Infinity});
      }else viewers.get(id).expires=at+WATCH_TTL;
      return json({ready:true,refreshSeconds:30,capacity:WATCH_LIMIT},200,{'set-cookie':`${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/watch; Max-Age=90`+(request.headers.get('x-forwarded-proto')==='https'?'; Secure':'')});
    }
    if(path==='/watch/data'){
      if(request.method!=='GET')return fail('관람 전용 데이터입니다.',405);
      const id=token(request),v=viewers.get(id);
      if(!v)return fail('관람 연결이 만료됐습니다. 다시 접속해 주세요.',410);
      if(at-v.lastRead<1000)return fail('갱신 요청이 너무 빠릅니다.',429,2);
      v.lastRead=at;v.expires=at+WATCH_TTL;
      try{return json(await snapshot(at),200,{'set-cookie':`${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/watch; Max-Age=90`+(request.headers.get('x-forwarded-proto')==='https'?'; Secure':'')});}
      catch{return fail('관람 데이터를 잠시 확인할 수 없습니다.',503);}
    }
    return fail('공개 관람 경로가 아닙니다.',404);
  };
}
