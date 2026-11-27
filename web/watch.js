'use strict';
const $=s=>document.querySelector(s),n=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}),won=v=>v==null?'—':n.format(Math.round(v))+'원';
let data=null,market='KR',timer=null,busy=false;
const text=(selector,value)=>{$(selector).textContent=value;};
const time=v=>Number.isFinite(v)?new Intl.DateTimeFormat('ko-KR',{timeZone:market==='US'?'America/New_York':'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(v):'—';
function cell(row,value,cls=''){const td=document.createElement('td');td.textContent=value;td.className=cls;row.append(td);return td;}
function instrumentCell(row,p){const td=cell(row,p.name||p.symbol),small=document.createElement('small');small.textContent=p.symbol;td.append(small);}
const percentage=v=>Number.isFinite(v)?(v>0?'+':'')+n.format(v)+'%':'—';
function svgNode(svg,tag,attributes={},label){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));if(label!==undefined)node.textContent=label;svg.append(node);return node;}
function plot(svg,series,{percent=false}={}){
  svg.replaceChildren();const width=Math.max(340,svg.clientWidth||900),height=280,left=percent?66:100,right=20,top=30,bottom=height-65;
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  const points=series.flatMap(s=>s.points).filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value));if(!points.length)return false;
  const from=Math.min(...points.map(p=>p.time)),until=Math.max(from+60000,...points.map(p=>p.time));
  const values=points.map(p=>p.value),low=Math.min(...values,...(percent?[0]:[])),high=Math.max(...values,...(percent?[0]:[])),padding=Math.max((high-low)*.08,percent?.1:1);
  const min=low-padding,max=high+padding,X=t=>left+(width-left-right)*(t-from)/(until-from),Y=v=>bottom-(bottom-top)*(v-min)/(max-min);
  for(let i=0;i<=4;i++){const value=min+(max-min)*i/4,y=Y(value);svgNode(svg,'line',{x1:left,x2:width-right,y1:y,y2:y,stroke:'#e3eaf1'});svgNode(svg,'text',{x:left-10,y:y+4,'text-anchor':'end',class:'axis-label'},percent?n.format(value)+'%':n.format(Math.round(value)));}
  const ticks=width<600?2:4;
  for(let i=0;i<=ticks;i++){const t=from+(until-from)*i/ticks,x=X(t);svgNode(svg,'line',{x1:x,x2:x,y1:bottom,y2:bottom+5,stroke:'#92a5b7'});
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:market==='US'?'America/New_York':'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(t).map(p=>[p.type,p.value]));
    svgNode(svg,'text',{x,y:bottom+23,'text-anchor':'middle',class:'axis-label'},parts.month+'/'+parts.day);svgNode(svg,'text',{x,y:bottom+40,'text-anchor':'middle',class:'axis-label'},parts.hour+':'+parts.minute);
  }
  svgNode(svg,'line',{x1:left,x2:left,y1:top,y2:bottom,stroke:'#92a5b7'});svgNode(svg,'line',{x1:left,x2:width-right,y1:bottom,y2:bottom,stroke:'#92a5b7'});
  svgNode(svg,'text',{x:8,y:16,class:'axis-label'},percent?'수익률 (%)':'금액 (원)');svgNode(svg,'text',{x:width-right,y:height-3,'text-anchor':'end',class:'axis-label'},market==='US'?'시간 (미국 동부)':'시간 (한국)');
  for(const s of series){const rows=s.points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)).sort((a,b)=>a.time-b.time);if(!rows.length)continue;
    svgNode(svg,'polyline',{points:rows.map(p=>X(p.time)+','+Y(p.value)).join(' '),fill:'none',stroke:s.color,'stroke-width':2.5});if(rows.length===1)svgNode(svg,'circle',{cx:X(rows[0].time),cy:Y(rows[0].value),r:3,fill:s.color});
  }return true;
}
function renderComparison(p){
  const benchmarks=p.benchmarks??[],body=$('#benchmark-rows'),legend=$('#benchmark-legend');body.replaceChildren();legend.replaceChildren();
  const colors=['#168679','#c68020','#385aa6','#a44688'],series=[];
  for(const [i,b] of benchmarks.entries()){
    const row=document.createElement('tr');cell(row,b.name||b.symbol);const period=cell(row,time(b.since)),observed=document.createElement('small');observed.textContent='최근 시세 '+time(b.time);period.append(observed);cell(row,percentage(b.strategyPct));cell(row,percentage(b.returnPct));
    const difference=Number.isFinite(b.strategyPct)&&Number.isFinite(b.returnPct)?b.strategyPct-b.returnPct:null;cell(row,difference==null?'—':(difference>0?'+':'')+n.format(difference)+'%p',difference==null?'':difference>=0?'gain':'loss');body.append(row);
    // Match the original dashboard: the strategy line uses the first benchmark's period.
    // The table retains every benchmark's own saved starting equity and FX period.
    if(i===0)series.push({name:'전략 · '+(b.name||b.symbol)+' 기준',color:'#6545e2',points:(b.points??[]).map(v=>({time:v.time,value:v.strategyPct}))});
    series.push({name:b.name||b.symbol,color:colors[i],points:(b.points??[]).map(v=>({time:v.time,value:v.benchmarkPct}))});
  }
  for(const s of series){const label=document.createElement('span');label.textContent=s.name;label.className=s.color==='#6545e2'?'legend-strategy':'legend-market'+colors.indexOf(s.color);legend.append(label);}
  const hasPoints=plot($('#benchmark-chart'),series,{percent:true});
  text('#benchmark-note',hasPoints?'기존 대시보드와 같은 저장 기준 · 비교 대상별 측정 시작 이후 원화 가격수익률입니다. 미국 ETF는 환율 변동을 포함하며 배당 재투자 수익률은 아닙니다.':'정규장 비교 데이터 수집 대기 · 관람 화면에서 시세를 추가 조회하지 않습니다.');
}
function render(){
  if(!data)return;const p=data.markets.find(p=>p.market===market);if(!p)return;
  $('#content').hidden=false;$('#kr').setAttribute('aria-pressed',String(market==='KR'));$('#us').setAttribute('aria-pressed',String(market==='US'));
  text('#updated','자료 확인 '+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(data.asOf)+' KST');
  const stats=$('#stats');stats.replaceChildren();for(const [label,v] of [['모의 원금',p.initial],['평가자산',p.total],['누적 평가손익',p.pnl],['현금',p.cash]]){const div=document.createElement('div');div.className='stat';const span=document.createElement('span'),strong=document.createElement('strong');span.textContent=label;strong.textContent=won(v);if(label.includes('손익'))strong.className=v>=0?'gain':'loss';div.append(span,strong);stats.append(div);}
  const price=v=>v==null?'—':market==='US'?'$'+n.format(v):won(v),positions=$('#positions');positions.replaceChildren();
  for(const h of p.positions){const row=document.createElement('tr');instrumentCell(row,h);cell(row,n.format(h.quantity));cell(row,price(h.price));cell(row,won(h.valueKrw));positions.append(row);}if(!p.positions.length){const row=document.createElement('tr');cell(row,'현재 보유 종목이 없습니다.');positions.append(row);}
  const trades=$('#trades');trades.replaceChildren();for(const t of p.trades){const row=document.createElement('tr');cell(row,time(t.time));instrumentCell(row,t);cell(row,t.side==='BUY'?'매수':'매도',t.side==='BUY'?'gain':'loss');cell(row,n.format(t.quantity));cell(row,price(t.price));cell(row,won(t.realized),t.realized==null?'':t.realized>=0?'gain':'loss');trades.append(row);}if(!p.trades.length){const row=document.createElement('tr');cell(row,'아직 체결 기록이 없습니다.');trades.append(row);}
  const points=p.history.filter(h=>Number.isFinite(h.total)&&Number.isFinite(h.time)).sort((a,b)=>a.time-b.time);
  const hasPoints=plot($('#chart'),[{color:'#247896',points:points.map(h=>({time:h.time,value:h.total}))}]);
  text('#chart-note',hasPoints?time(points[0].time)+' ~ '+time(points.at(-1).time)+' · 확인된 관측 시각 간격을 그대로 표시합니다.':'추이를 표시할 관측값이 쌓이는 중입니다.');
  renderComparison(p);
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
window.addEventListener('resize',()=>{if(data)render();});
