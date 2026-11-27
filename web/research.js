const form=document.querySelector('#research-form'),output=document.querySelector('#progress');
form.elements.end.value=new Date(Date.now()+9*3600000-86400000).toISOString().slice(0,10);
async function request(method='GET',action){
 const response=await fetch('/api/research',{method,headers:method==='POST'?{'content-type':'application/json'}:{},...(method==='POST'?{body:JSON.stringify({action,start:form.elements.start.value,end:form.elements.end.value})}:{})});
 if(response.status===401){location.href='/login?next=/research';return;}
 const result=await response.json();if(!response.ok)throw Error(result.error??'조회하지 못했습니다.');return result;
}
async function refresh(){try{const m=await request();if(!m)return;if(m.start){form.elements.start.value=m.start;form.elements.end.value=m.end;}output.textContent=[m.message,'상태: '+m.status,'완료 종목: '+(m.completed?.length??0)+' / '+(m.total??'?'),'조회 불가: '+(m.unavailable?.length??0),'저장 페이지: '+(m.pages??0),'저장 봉: '+(m.bars??0)+' (경계 중복 포함, 전체성 검증 전)'].join('\n');}catch(e){output.textContent=e.message;}}
form.addEventListener('submit',async e=>{e.preventDefault();try{await request('POST','start');await refresh();}catch(e){output.textContent=e.message;}});
document.querySelector('#pause').addEventListener('click',async()=>{try{await request('POST','stop');await refresh();}catch(e){output.textContent=e.message;}});
refresh();setInterval(refresh,5000);
