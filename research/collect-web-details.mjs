import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseNewsDetail,dartDocumentUrl} from './web-history.mjs';
const root='outputs/research/web-history',dir=root+'/details';
const selectedDate=process.argv.find(v=>v.startsWith('--date='))?.slice(7);
if(selectedDate&&!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate))throw Error('날짜 형식을 확인해 주세요.');
await mkdir(dir,{recursive:true});
let news=0,disclosures=0,newsUnavailable=false;
async function html(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('HTTP '+r.status);
  const t=new TextDecoder((r.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]??'utf-8').replace(/ms949/i,'euc-kr')).decode(await r.arrayBuffer());
  await new Promise(resolve=>setTimeout(resolve,350));
  return t;
}
for(const file of (await readdir(root)).filter(n=>/^2026.*json$/.test(n)&&(!selectedDate||n===selectedDate+'.json')).sort()){
  const day=JSON.parse(await readFile(root+'/'+file,'utf8'));
  const output=dir+'/'+file;
  let saved={};try{saved=JSON.parse(await readFile(output,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const result={date:day.date,items:[]};
  const articles=(day.news.items??[]).filter(i=>i.changedDate===false&&/코스피|증시|금리|반도체|삼성전자|하이닉스/.test(i.title)).slice(0,2);
  const filings=(day.dart.items??[]).filter(i=>/중대재해|유상증자|공급계약|영업.*실적|회생|영업.*정지/.test(i.title)).slice(0,1);
  for(const item of [...articles,...filings]){
    const cached=saved.items?.find(i=>i.url===item.url&&!i.error);
    if(cached){result.items.push(cached);continue;}
    if(item.kind==='news'&&newsUnavailable){result.items.push({...item,error:'기사 원문 조회 일시 중단, 목록 메타데이터 보존'});continue;}
    try{
      const raw=await html(item.kind==='news'?item.url.split('?')[0]:item.url);
      if(item.kind==='news'){
        result.items.push({...item,...parseNewsDetail(raw),currentPageHash:createHash('sha256').update(raw).digest('hex')});news++;
      }else{
        const documentUrl=dartDocumentUrl(raw);
        if(!documentUrl)throw Error('공시 본문 링크 확인 필요');
        const body=await html(documentUrl);
        const text=body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
        result.items.push({...item,documentUrl,documentHash:createHash('sha256').update(body).digest('hex'),
          textLength:text.length,excerpt:text.slice(0,200),bodyRetrievedAt:new Date().toISOString(),
          evidenceGrade:'official-document-retrieved',originalVersionVerified:false});disclosures++;
      }
    }catch(error){if(item.kind==='news')newsUnavailable=true;result.items.push({...item,error:error.message});}
  }
  await writeFile(output,JSON.stringify(result,null,2));
}
console.log(JSON.stringify({newNewsDetails:news,newDisclosureDocuments:disclosures}));
