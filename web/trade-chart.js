import {createChart,CandlestickSeries,LineSeries,HistogramSeries,createSeriesMarkers,ColorType,CrosshairMode} from './vendor/lightweight-charts/lightweight-charts.mjs';
import {fillReasons} from './trade-chart-layout.mjs?v=20261126-tv3';
import {chartCandles,originalChartUrl,chartFills} from './trade-chart-data.mjs?v=20261126-tv3';
const $=s=>document.querySelector(s);
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const number=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:4});
const timeFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const tickFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
const stamp=t=>timeFormat.format(t);
export function initTradeChart({request,market,preview,state}){
  const dialog=$('#trade-chart-dialog'),content=$('#trade-chart-content'),plot=$('#trade-chart-engine'),tooltip=$('#trade-chart-tooltip'),status=$('#trade-chart-status'),observations=$('#trade-chart-observations');
  let result=null,sequence=0,invoker=null,chart=null,candleSeries=null,volumeSeries=null,lineSeries=null,tradeSeries=null,markerPlugin=null,priceLine=null,minutes=1,displayed=[];
  const price=v=>v==null?'미확인':(result.currency==='USD'?'$':'')+number.format(v)+(result.currency==='KRW'?'원':'');
  const chosen=()=>result?.trades.find(t=>t.id===result.selectedId);
  function detail(){
    const t=chosen();if(!t)return;
    $('#trade-chart-detail').innerHTML='<p class="trade-chart-selected"><strong>'+(t.side==='BUY'?'매수':'매도')+' '+number.format(t.quantity)+'주 · '+price(t.price)+'</strong><span>'+stamp(t.time)+' · 한국 시간'+(t.realized!=null&&t.side==='SELL'?' · 실현손익 '+number.format(t.realized)+'원':'')+'</span></p><p class="trade-chart-reason">'+safe(t.reason||'저장된 매매 이유가 없습니다.')+'</p>';
    $('#trade-chart-fills').innerHTML='<div class="chart-fill-caption">'+(result.date?'하루 전체':'같은 매매 묶음')+' 체결 '+result.trades.length+'건 <span>체결을 선택하면 해당 구간으로 이동합니다.</span></div><div class="trade-chart-fill-list">'+result.trades.map(t=>'<button type="button" class="trade-chart-fill" data-chart-fill="'+safe(t.id)+'" aria-pressed="'+(t.id===result.selectedId)+'"><span class="'+(t.side==='BUY'?'chart-buy':'chart-sell')+'">'+(t.side==='BUY'?'매수':'매도')+'</span><span>'+stamp(t.time)+'</span><strong>'+price(t.price)+'</strong><span>'+number.format(t.quantity)+'주</span></button>').join('')+'</div>';
  }
  function focus(){
    const t=chosen();if(!chart||!t)return;
    chart.timeScale().setVisibleRange({from:t.time/1000-30*60,to:t.time/1000+90*60});
    requestAnimationFrame(()=>{if(!chart)return;const range=chart.timeScale().getVisibleLogicalRange();if(range&&range.from<2)chart.timeScale().setVisibleLogicalRange({from:-5,to:range.to});});
  }
  function markers(){
    displayed=chartFills(result.trades.filter(t=>t.price>0),result.selectedId,minutes);
    markerPlugin.setMarkers([]);const fills=new Map();for(const t of displayed)fills.set(t.markerTime,{time:t.markerTime,value:t.price});tradeSeries.setData([...fills.values()].sort((a,b)=>a.time-b.time));
    markerPlugin.setMarkers(displayed.map(t=>({id:t.id,time:t.markerTime,position:'atPriceMiddle',price:t.price,shape:t.side==='BUY'?'arrowUp':'arrowDown',color:t.side==='BUY'?'#d83b48':'#2879e0',size:t.id===result.selectedId?.8:.6,text:t.id===result.selectedId?(t.side==='BUY'?'매수 ':'매도 ')+price(t.price):t.members.length>1?'×'+t.members.length:''})));
    if(priceLine)tradeSeries.removePriceLine(priceLine);
    const t=chosen();if(t?.price>0)priceLine=tradeSeries.createPriceLine({price:t.price,color:t.side==='BUY'?'#d83b4880':'#2879e080',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:t.side==='BUY'?'매수':'매도'});
  }
  function showTooltip(t,point){
    tooltip.innerHTML='<strong>'+(t.side==='BUY'?'매수':'매도')+' '+number.format(t.quantity)+'주 · '+price(t.price)+(t.members.length>1?' · '+t.members.length+'건 묶음':'')+'</strong><p>'+safe(stamp(t.time))+'</p>'+fillReasons(t).slice(0,4).map(r=>'<p>'+safe(r.reason)+(t.members.length>1?' ('+r.count+'건)':'')+'</p>').join('');
    tooltip.hidden=false;tooltip.style.left=Math.max(8,Math.min(plot.clientWidth-tooltip.offsetWidth-12,point.x+16))+'px';tooltip.style.top=Math.max(8,Math.min(plot.clientHeight-tooltip.offsetHeight-12,point.y+20))+'px';
  }
  function hovered(event){
    if(!chart||!event.point)return null;
    const id=event.hoveredInfo?.objectId??event.hoveredObjectId;
    return displayed.find(t=>t.id===id)??[...displayed].reverse().find(t=>{const x=chart.timeScale().timeToCoordinate(t.markerTime),y=tradeSeries.priceToCoordinate(t.price);return x!=null&&y!=null&&Math.hypot(x-event.point.x,y-event.point.y)<18;});
  }
  function setBars(){
    const bars=chartCandles(result.candles??[],minutes);candleSeries.setData(bars.map(({volume,...bar})=>bar));
    volumeSeries.setData(bars.map(b=>({time:b.time,value:b.volume,color:b.close>=b.open?'#d83b4860':'#2879e060'})));
    $('#trade-chart-source').textContent=bars.length?minutes+'분봉 · '+bars.length+'개':'저장된 관측가';
    document.querySelectorAll('[data-chart-interval]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.chartInterval)===minutes)));
  }
  function create(){
    chart?.remove();chart=null;tooltip.hidden=true;plot.replaceChildren();
    const format={type:'price',precision:result.currency==='USD'?2:0,minMove:result.currency==='USD'?.01:1};
    chart=createChart(plot,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#ffffff'},textColor:'#667085',fontFamily:'-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',fontSize:12,attributionLogo:true},grid:{vertLines:{color:'#f0f2f5'},horzLines:{color:'#f0f2f5'}},rightPriceScale:{borderColor:'#e8ecf1',scaleMargins:{top:.15,bottom:.14}},timeScale:{borderColor:'#e8ecf1',timeVisible:true,secondsVisible:false,barSpacing:8,rightOffset:6,tickMarkFormatter:t=>tickFormat.format(Number(t)*1000)},crosshair:{mode:CrosshairMode.Normal},localization:{locale:'ko-KR',timeFormatter:t=>stamp(Number(t)*1000)},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true}});
    candleSeries=chart.addSeries(CandlestickSeries,{upColor:'#d83b48',downColor:'#2879e0',wickUpColor:'#d83b48',wickDownColor:'#2879e0',borderVisible:false,priceLineVisible:false,priceFormat:format});
    volumeSeries=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);chart.panes()[1].setHeight(88);
    lineSeries=chart.addSeries(LineSeries,{color:'#8b5cf6',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,visible:observations.checked||!result.candles?.length,priceFormat:format});
    lineSeries.setData(observations.checked||!result.candles?.length?result.points.map(p=>({time:p.time/1000,value:p.price})):[]);
    tradeSeries=chart.addSeries(LineSeries,{color:'transparent',lineVisible:false,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,priceFormat:format});

    markerPlugin=createSeriesMarkers(tradeSeries,[],{autoScale:true,zOrder:'top'});setBars();priceLine=null;markers();focus();
    chart.subscribeCrosshairMove(event=>{tooltip.hidden=true;const t=hovered(event);if(t)showTooltip(t,event.point);const c=event.seriesData.get(candleSeries);$('#trade-chart-hover').textContent=c?.open!=null?stamp(Number(c.time)*1000)+' · 시 '+price(c.open)+'  고 '+price(c.high)+'  저 '+price(c.low)+'  종 '+price(c.close):'휠로 확대·축소 · 드래그로 이동 · 매매 표식에 마우스를 올리면 판단 이유를 표시합니다.';});
    chart.subscribeClick(event=>{const t=hovered(event);if(t)select(t.members.at(-1).id,false);});
  }
  function select(id,move=true){result.selectedId=id;tooltip.hidden=true;detail();markers();if(move)focus();}
  async function open(id,target,date=null){
    const token=++sequence;invoker=target;result=null;chart?.remove();chart=null;tooltip.hidden=true;content.hidden=true;status.hidden=false;status.textContent='차트를 불러오는 중입니다.';$('#trade-chart-title').textContent='거래 차트';$('#trade-chart-subtitle').textContent='';if(!dialog.open)dialog.showModal();
    try{
      let data;if(preview()){const s=state(),t=s.trades.find(t=>String(t.id)===id);if(!t)throw Error('거래를 찾을 수 없습니다.');data={symbol:t.symbol,name:t.name,currency:market()==='US'?'USD':'KRW',market:market(),selectedId:id,points:[],candles:[],trades:s.trades.filter(p=>p.symbol===t.symbol).map(p=>({...p,id:String(p.id),price:market()==='US'?p.priceUsd:p.price})),note:'예시 거래입니다. 기록되지 않은 시세는 생성하지 않습니다.'};}else data=await request((market()==='US'?'/api/us/trade-chart':'/api/trade-chart')+'?id='+encodeURIComponent(id)+(date?'&date='+date:''));
      if(token!==sequence||!dialog.open)return;result=data;minutes=1;observations.checked=false;observations.disabled=!data.points.length;
      $('#trade-chart-title').textContent=data.name;$('#trade-chart-subtitle').textContent=data.symbol+' · '+(data.date??'매매 묶음')+' · '+data.currency+' · 한국 시간';
      $('#trade-chart-original').href=originalChartUrl(data.market,data.symbol);
      $('#trade-chart-data-note').textContent='차트: TradingView Lightweight Charts™ · 시세: 토스증권 · 원본 1분봉 종료 시각을 봉 시작 시각으로 변환합니다.'+(data.candleStatus!=='complete'?' 일부 API 자료를 확인하지 못해 저장 자료를 함께 사용합니다.':'');
      status.hidden=true;content.hidden=false;detail();create();
    }catch(error){if(token===sequence&&dialog.open){status.hidden=false;status.textContent=error.message;}}
  }
  document.addEventListener('click',event=>{const t=event.target.closest('[data-trade-chart]');if(t&&!window.getSelection()?.toString())open(t.dataset.tradeChart,t.closest('button')??t.querySelector('button')??t,t.dataset.chartDate??null);});
  $('#trade-chart-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{sequence++;chart?.remove();chart=null;result=null;tooltip.hidden=true;invoker?.isConnected&&invoker.focus();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  $('#trade-chart-fills').addEventListener('click',event=>{const t=event.target.closest('[data-chart-fill]');if(t&&result)select(t.dataset.chartFill);});
  observations.addEventListener('change',()=>{if(!chart)return;const range=chart.timeScale().getVisibleRange(),visible=observations.checked||!result.candles?.length;lineSeries.setData(visible?result.points.map(p=>({time:p.time/1000,value:p.price})):[]);lineSeries.applyOptions({visible});if(range)chart.timeScale().setVisibleRange(range);});
  document.querySelectorAll('[data-chart-interval]').forEach(b=>b.addEventListener('click',()=>{if(chart){const range=chart.timeScale().getVisibleRange();minutes=Number(b.dataset.chartInterval);setBars();markers();if(range)chart.timeScale().setVisibleRange(range);}}));
  $('#trade-chart-all').addEventListener('click',()=>chart?.timeScale().fitContent());$('#trade-chart-focus').addEventListener('click',focus);
}
