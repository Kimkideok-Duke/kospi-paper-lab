import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseDart,parseNews} from './web-history.mjs';
const root='outputs/research/web-history';
await mkdir(root,{recursive:true});
const {bars}=JSON.parse(await readFile('outputs/research/kospi-daily.json','utf8'));
const maxNewsPages=Number(process.argv[2]??3);
const coverage=[];
async function request(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const buffer=await response.arrayBuffer();
  const charset=response.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]??'utf-8';
  const html=new TextDecoder(charset).decode(buffer);
  await new Promise(resolve=>setTimeout(resolve,350));
  return html;
}
async function collectDart(date) {
  const items=new Map();let total=null,page=1;
  for(;page<=20;page++) {
    const url='https://dart.fss.or.kr/dsac001/mainY.do?'+new URLSearchParams({mdayCnt:'0',selectDate:date.replaceAll('-','.'),currentPage:String(page)});
    const result=parseDart(await request(url),date);
    if(!Number.isFinite(result.total))throw Error('DART 목록 확인 실패');
    total=total===null?result.total:Math.max(total,result.total);
    let added=0;for(const item of result.items)if(!items.has(item.url)){items.set(item.url,item);added++;}
    if(items.size>=total)break;
    if(!added)break;
  }
  return {items:[...items.values()],status:items.size===total?'listing-complete':'partial',total,pages:page};
}
async function collectNews(date) {
  const first='https://news.nate.com/subsection?'+new URLSearchParams({cate:'eco04',date:date.replaceAll('-',''),mid:'n0304',page:'1',type:'c'});
  const queue=[{url:first,page:1}],seen=new Set(),items=new Map();let remaining=false;
  while(queue.length&&seen.size<maxNewsPages) {
    queue.sort((a,b)=>a.page-b.page);const next=queue.shift();
    if(seen.has(next.page))continue;
    seen.add(next.page);
    const result=parseNews(await request(next.url),date);
    if(!result.items.length)throw Error('뉴스 목록 읽기 실패');
    for(const item of result.items)items.set(item.url,item);
    for(const link of result.pages)if(!seen.has(link.page)&&!queue.some(p=>p.page===link.page))queue.push(link);
  }
  remaining=queue.some(p=>!seen.has(p.page));
  return {items:[...items.values()],status:remaining?'partial':'listing-complete',pages:seen.size,unvisitedPages:queue.map(p=>p.page)};
}
let cursor=0;
async function worker(){
while(cursor<bars.length) {
  const index=cursor++,bar=bars[index];
  const file=root+'/'+bar.date+'.json';
  let old={};try{old=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const result={date:bar.date,retrievedAt:new Date().toISOString()};
  for(const [name,fn]of [['dart',collectDart],['news',collectNews]]) {
    if(name==='news'&&process.argv.includes('--dart-only')){result.news=old.news??{status:'not-collected',items:[]};continue;}
    if(old[name]?.status==='listing-complete'||(name==='news'&&old.news?.pages>=maxNewsPages)){result[name]=old[name];continue;}
    try{result[name]=await fn(bar.date);}catch(error){result[name]={...old[name],status:'failed',error:String(error.message)};}
  }
  await writeFile(file,JSON.stringify(result,null,2));
  coverage.push({date:bar.date,dart:result.dart.status,disclosures:result.dart.items?.length??0,
    news:result.news.status,articles:result.news.items?.length??0});
  if(index%10===0)console.log(JSON.stringify({progress:index+1,total:bars.length,date:bar.date}));
}
}
await Promise.all([worker(),worker()]);
coverage.sort((a,b)=>a.date.localeCompare(b.date));
const summary={dates:coverage.length,disclosures:coverage.reduce((n,c)=>n+c.disclosures,0),
  articles:coverage.reduce((n,c)=>n+c.articles,0),dartComplete:coverage.filter(c=>c.dart==='listing-complete').length,
  newsComplete:coverage.filter(c=>c.news==='listing-complete').length,coverage};
await writeFile(root+'/coverage.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,coverage:undefined}));
