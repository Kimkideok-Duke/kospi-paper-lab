import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {X_ACCOUNTS} from './social-evidence.mjs';
const dir='outputs/research/social';
await mkdir(dir,{recursive:true});
const observedAt=Date.now();
const url='https://www.paxnet.co.kr/tbbs/list?id=005930';
const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
const html=await response.text();
const items=[];
if(response.ok)for(const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)){
  const title=match[1].match(/class="best-title"[^>]*>([\s\S]*?)<\/a>/)?.[1]?.replace(/<[^>]*>/g,' ').trim();
  const time=match[1].match(/data-date-format="([^"]+)"/)?.[1];
  if(!title||!time)continue;
  const publishedAt=Date.parse(time.replace('KST','GMT+0900'));
  items.push({kind:'community',symbol:'005930',source:'Paxnet',title,url,publishedAt,observedAt,
    availableAt:observedAt,versionAt:observedAt,originalVersionVerified:false});
}
await writeFile(dir+'/paxnet-current.json',JSON.stringify({url,status:response.status,observedAt,items},null,2));
await writeFile(dir+'/x-watchlist.json',JSON.stringify({observedAt,accounts:X_ACCOUNTS},null,2));
console.log(JSON.stringify({communityPosts:items.length,xAccounts:X_ACCOUNTS.length,xOriginalPosts:0}));
