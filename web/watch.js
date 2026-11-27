'use strict';
const $=s=>document.querySelector(s),n=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}),won=v=>v==null?'—':n.format(Math.round(v))+'원';
let data=null,market='KR',timer=null,busy=false;
const text=(selector,value)=>{$(selector).textContent=value;};
const time=v=>Number.isFinite(v)?new Intl.DateTimeFormat('ko-KR',{timeZone:market==='US'?'America/New_York':'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(v):'—';
function cell(row,value,cls=''){const td=document.createElement('td');td.textContent=value;td.className=cls;row.append(td);return td;}
function instrumentCell(row,p){const td=cell(row,p.name||p.symbol),small=document.createElement('small');small.textContent=p.symbol;td.append(small);}
function render(){
  if(!data)return;const p=data.markets.find(p=>p.market===market);if(!p)return;
  $('#content').hidden=false;$('#kr').setAttribute('aria-pressed',String(market==='KR'));$('#us').setAttribute('aria-pressed',String(market==='US'));
  text('#updated','자료 확인 '+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(data.asOf)+' KST');
  const stats=$('#stats');stats.replaceChildren();for(const [label,v] of [['모의 원금',p.initial],['평가자산',p.total],['누적 평가손익',p.pnl],['현금',p.cash]]){const div=document.createElement('div');div.className='stat';const span=document.createElement('span'),strong=document.createElement('strong');span.textContent=label;strong.textContent=won(v);if(label.includes('손익'))strong.className=v>=0?'gain':'loss';div.append(span,strong);stats.append(div);}
  const price=v=>v==null?'—':market==='US'?'$'+n.format(v):won(v),positions=$('#positions');positions.replaceChildren();
  for(const h of p.positions){const row=document.createElement('tr');instrumentCell(row,h);cell(row,n.format(h.quantity));cell(row,price(h.price));cell(row,won(h.valueKrw));positions.append(row);}if(!p.positions.length){const row=document.createElement('tr');cell(row,'현재 보유 종목이 없습니다.');positions.append(row);}
  const trades=$('#trades');trades.replaceChildren();for(const t of p.trades){const row=document.createElement('tr');cell(row,time(t.time));instrumentCell(row,t);cell(row,t.side==='BUY'?'매수':'매도',t.side==='BUY'?'gain':'loss');cell(row,n.format(t.quantity));cell(row,price(t.price));cell(row,won(t.realized),t.realized==null?'':t.realized>=0?'gain':'loss');trades.append(row);}if(!p.trades.length){const row=document.createElement('tr');cell(row,'아직 체결 기록이 없습니다.');trades.append(row);}
  const svg=$('#chart');svg.replaceChildren();const points=p.history.filter(h=>Number.isFinite(h.total)&&Number.isFinite(h.time));
  if(points.length>1){const min=Math.min(...points.map(h=>h.total)),max=Math.max(...points.map(h=>h.total)),line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('points',points.map((h,i)=>(12+876*i/(points.length-1))+','+(180-160*(h.total-min)/(max-min||1))).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#247896');line.setAttribute('stroke-width','2.5');svg.append(line);text('#chart-note',time(points[0].time)+' ~ '+time(points.at(-1).time)+' · '+won(min)+' ~ '+won(max));}else text('#chart-note','추이를 표시할 관측값이 쌓이는 중입니다.');
}
async function call(path,method='GET'){const r=await fetch(path,{method,credentials:'same-origin',cache:'no-store'});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.error||'연결을 확인할 수 없습니다.'),{status:r.status});return result;}
async function update(join=false){
  if(busy)return;busy=true;clearTimeout(timer);$('#retry').hidden=true;
  try{if(join)await call('/watch/join','POST');try{data=await call('/watch/data');}catch(e){if(e.status!==410||join)throw e;await call('/watch/join','POST');data=await call('/watch/data');}render();text('#status','모의 거래 관람 중 · '+(market==='US'?'체결 시각은 미국 동부시간':'체결 시각은 한국시간'));}
  catch(e){text('#status',e.message+' · 30초 뒤 다시 확인합니다. 기존 자료는 마지막 확인 시점 기준입니다.');$('#retry').hidden=false;}
  finally{busy=false;timer=setTimeout(()=>{if(!document.hidden)update(false);},30000);}
}
$('#kr').addEventListener('click',()=>{market='KR';render();text('#status','모의 거래 관람 중 · 체결 시각은 한국시간');});
$('#us').addEventListener('click',()=>{market='US';render();text('#status','모의 거래 관람 중 · 체결 시각은 미국 동부시간');});
$('#retry').addEventListener('click',()=>update(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden)update(false);});update(true);
