import { displayFills } from './trade-chart-layout.mjs';
const $ = selector => document.querySelector(selector);
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 });
const stamp = value => new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).format(value);
const signed = value => (value > 0 ? '+' : '') + number.format(value) + '원';

export function initTradeChart({ request, market, preview, state }) {
  const dialog = $('#trade-chart-dialog'), canvas = $('#trade-chart-canvas'), content = $('#trade-chart-content'), status = $('#trade-chart-status');
  let result = null, sequence = 0, invoker = null, hover = null, markers = [];
  const price = value => value == null ? '미확인' : (result.currency === 'USD' ? '$' : '') + number.format(value) + (result.currency === 'KRW' ? '원' : '');
  const selected = () => result?.trades.find(t => t.id === result.selectedId);
  function detail() {
    const t = selected();
    if (!t) return;
    const pnl = t.side === 'SELL' && t.realized != null ? ' · 실현손익 ' + signed(t.realized) : '';
    $('#trade-chart-detail').innerHTML = '<p class="trade-chart-selected"><strong>' + (t.side === 'BUY' ? '매수' : '매도') + ' ' + number.format(t.quantity) + '주 · ' + price(t.price) + '</strong><span>' + stamp(t.time) + ' (한국 시간)' + safe(pnl) + (t.fxRate ? ' · 환율 ' + number.format(t.fxRate) + '원' : '') + '</span></p><p class="trade-chart-reason">' + safe(t.reason || '저장된 매매 이유가 없습니다.') + '</p>';
    $('#trade-chart-fills').innerHTML = '<p class="news-meta">같은 매매 묶음의 체결 ' + result.trades.length + '건 · 아래 체결을 선택하면 차트에서 강조합니다.</p><div class="trade-chart-fill-list">' + result.trades.map(t => '<button type="button" class="trade-chart-fill" data-chart-fill="' + safe(t.id) + '" aria-pressed="' + (t.id === result.selectedId) + '"><span class="' + (t.side === 'BUY' ? 'chart-buy' : 'chart-sell') + '">' + (t.side === 'BUY' ? '매수' : '매도') + '</span><span>' + stamp(t.time) + '</span><strong>' + price(t.price) + '</strong><span>' + number.format(t.quantity) + '주</span></button>').join('') + '</div>';
  }
  function draw() {
    if (!result || !dialog.open || content.hidden) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const pixel = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * pixel); canvas.height = Math.round(height * pixel);
    const ctx = canvas.getContext('2d'); ctx.scale(pixel, pixel);
    const axisNumber = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: result.currency === 'KRW' ? 0 : 2 });
    const fills = result.trades.filter(t => t.price > 0 && Number.isFinite(t.time));
    const all = [...result.points, ...fills];
    if (!all.length) { ctx.fillStyle='#62657b';ctx.font='16px system-ui';ctx.fillText('표시할 가격 정보가 없습니다.',25,60);return; }
    const times = all.map(p => p.time), prices = all.map(p => p.price), first = Math.min(...times), last = Math.max(...times);
    const span = Math.max(60000,last-first), from=first-span*.025, until=last+span*.025;
    const low=Math.min(...prices), high=Math.max(...prices), padding=Math.max((high-low)*.15,high*.002,.01);
    const left = width < 500 ? 66 : 90, right = width-24, top=28, bottom=height-42;
    const X=t=>left+(right-left)*(t-from)/(until-from), Y=p=>bottom-(bottom-top)*(p-low+padding)/(high-low+padding*2);
    ctx.font='12px system-ui';ctx.lineWidth=1;
    for(let i=0;i<=4;i++){
      const value=low-padding+(high-low+padding*2)*i/4,y=Y(value);
      ctx.strokeStyle='#e9e9f2';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
      ctx.fillStyle='#62657b';ctx.textAlign='right';ctx.fillText(axisNumber.format(value),left-8,y+4);
    }
    ctx.textAlign='center';
    const axisTime=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',...(span>86400000?{month:'numeric',day:'numeric'}:{}),hour:'2-digit',minute:'2-digit',hour12:false});
    const ticks=width<500?3:5;
    for(let i=0;i<ticks;i++){const t=first+(last-first)*i/(ticks-1);ctx.fillText(axisTime.format(t),X(t),height-14);}
    ctx.fillStyle='#62657b';ctx.textAlign='left';ctx.fillText(result.currency,8,14);
    // Dashed connectors express a data gap, rather than inventing missing observations.
    ctx.save();ctx.strokeStyle='#a7a0bd';ctx.lineWidth=1;ctx.setLineDash([5,5]);ctx.beginPath();
    result.points.forEach((p,i)=>{if(i&&p.time-result.points[i-1].time>180000){const prior=result.points[i-1];ctx.moveTo(X(prior.time),Y(prior.price));ctx.lineTo(X(p.time),Y(p.price));}});ctx.stroke();ctx.restore();
    ctx.strokeStyle='#7650e8';ctx.lineWidth=2;ctx.beginPath();
    result.points.forEach((p,i)=>{if(!i||p.time-result.points[i-1].time>180000)ctx.moveTo(X(p.time),Y(p.price));else ctx.lineTo(X(p.time),Y(p.price));});ctx.stroke();
    for(const p of result.points){ctx.fillStyle='#7650e8';ctx.beginPath();ctx.arc(X(p.time),Y(p.price),2,0,Math.PI*2);ctx.fill();}
    const chosen=selected();
    if(chosen?.price>0){ctx.setLineDash([4,4]);ctx.strokeStyle='#b8aecf';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(X(chosen.time),top);ctx.lineTo(X(chosen.time),bottom);ctx.stroke();ctx.setLineDash([]);}
    markers = [];
    // Draw selected fill last, so coincident partial fills never hide the chosen point.
    const displayed = displayFills(fills, result.selectedId);
    for(const t of [...displayed.filter(t=>t.id!==result.selectedId),...displayed.filter(t=>t.id===result.selectedId)]){
      const x=X(t.time),y=Y(t.price),buy=t.side==='BUY',r=t.id===result.selectedId?8:6;
      ctx.fillStyle=buy?'#c43750':'#2665bc';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(x,y+(buy?-r:r));ctx.lineTo(x-r,y+(buy?r:-r));ctx.lineTo(x+r,y+(buy?r:-r));ctx.closePath();ctx.fill();ctx.stroke();
      if(t.members.length>1){ctx.font='11px system-ui';ctx.fillStyle=buy?'#a3213b':'#1e5299';ctx.textAlign='left';ctx.fillText('×'+t.members.length,x+9,y+4);ctx.font='12px system-ui';}
      if(t.id===result.selectedId){ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.strokeStyle=buy?'#c43750':'#2665bc';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.textAlign=x>width*.7?'right':'left';ctx.fillText((buy?'매수 ':'매도 ')+price(t.price),x+(x>width*.7?-16:16),Math.max(top+12,y-15));}
      markers.push({x,y,trade:t});
    }
    if(hover){
      const p=all.reduce((best,p)=>Math.abs(X(p.time)-hover.x)<Math.abs(X(best.time)-hover.x)?p:best,all[0]);
      ctx.setLineDash([3,3]);ctx.strokeStyle='#aaa1bd';ctx.beginPath();ctx.moveTo(X(p.time),top);ctx.lineTo(X(p.time),bottom);ctx.stroke();ctx.setLineDash([]);
      const near=[...markers].reverse().find(m=>Math.hypot(m.x-hover.x,m.y-hover.y)<16);
      $('#trade-chart-hover').textContent=near?stamp(near.trade.time)+' · '+(near.trade.side==='BUY'?'매수':'매도')+' '+number.format(near.trade.quantity)+'주 · '+price(near.trade.price)+(near.trade.members.length>1?' · 5분 구간 '+near.trade.members.length+'건 가중평균':''):stamp(p.time)+' · '+price(p.price)+' · 가장 가까운 저장 시점';
    }
    canvas.setAttribute('aria-label',result.name+' 가격 차트. '+result.points.length+'개 저장 시세, 매수 '+fills.filter(t=>t.side==='BUY').length+'건, 매도 '+fills.filter(t=>t.side==='SELL').length+'건. 체결 목록에서 각 지점을 선택할 수 있습니다.');
  }
  async function open(id, target) {
    const token=++sequence, selectedMarket=market();invoker=target;result=null;hover=null;markers=[];
    content.hidden=true;status.textContent='저장된 가격과 체결 지점을 불러오는 중입니다.';
    $('#trade-chart-title').textContent='거래 차트';$('#trade-chart-subtitle').textContent='';
    if(!dialog.open)dialog.showModal();
    try{
      let data;
      if(preview()){
        const s=state(), t=s.trades.find(t=>String(t.id)===id);
        if(!t)throw new Error('예시 거래를 찾을 수 없습니다.');
        data={market:selectedMarket,currency:selectedMarket==='US'?'USD':'KRW',symbol:t.symbol,name:t.name,selectedId:id,points:[],trades:s.trades.filter(p=>p.symbol===t.symbol).map(p=>({...p,id:String(p.id),price:selectedMarket==='US'?p.priceUsd??null:p.price})),note:'화면 예시 거래입니다. 가격 경로를 생성하지 않고 샘플 체결 지점만 표시합니다.',gaps:0};
      }else data=await request((selectedMarket==='US'?'/api/us/trade-chart':'/api/trade-chart')+'?id='+encodeURIComponent(id));
      if(token!==sequence||!dialog.open)return;
      result=data;
      $('#trade-chart-title').textContent=data.name+' · 매매 차트';
      $('#trade-chart-subtitle').textContent=data.symbol+' · '+data.currency+' · '+(data.open===true?'보유 중':data.open===false?'완결 매매':'저장된 체결')+' · 한국 시간';
      status.textContent=data.note+(data.trades.length>24?' 부분 체결은 같은 방향의 5분 구간별 가중평균 표식으로 묶고, 선택한 체결은 정확한 위치에 별도 표시합니다.':'')+(data.sampled?' 장기 보유 구간 일부 관측은 간추려 표시합니다.':'');
      content.hidden=false;detail();draw();
    }catch(error){if(token===sequence&&dialog.open)status.textContent=error.message;}
  }
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-trade-chart]');
    if(!target||window.getSelection()?.toString())return;
    open(target.dataset.tradeChart,target.closest('button')??target.querySelector('button')??target);
  });
  $('#trade-chart-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>{sequence++;result=null;hover=null;invoker?.isConnected&&invoker.focus();});
  $('#trade-chart-fills').addEventListener('click',event=>{const target=event.target.closest('[data-chart-fill]');if(!target||!result)return;result.selectedId=target.dataset.chartFill;hover=null;detail();draw();$('#trade-chart-fills').querySelector('[aria-pressed=true]')?.focus({preventScroll:true});});
  canvas.addEventListener('pointermove',event=>{hover={x:event.offsetX,y:event.offsetY};draw();});
  canvas.addEventListener('pointerleave',()=>{hover=null;$('#trade-chart-hover').textContent='차트에 마우스를 올리거나 체결 표식을 클릭해 상세 내용을 확인하세요.';draw();});
  canvas.addEventListener('click',event=>{const marker=[...markers].reverse().find(m=>Math.hypot(m.x-event.offsetX,m.y-event.offsetY)<16);if(marker){result.selectedId=marker.trade.members.at(-1).id;detail();draw();}});
  new ResizeObserver(draw).observe(canvas.parentElement);
}
