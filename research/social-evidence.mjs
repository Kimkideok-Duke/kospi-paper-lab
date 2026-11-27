import {evidenceAt} from './evidence.mjs';
export const X_ACCOUNTS = [
  {handle:'realDonaldTrump',role:'정책·관세·무역',identitySource:'https://www.whitehouse.gov/releases/2026/02/what-they-are-saying-president-trump-heralds-americas-golden-age-in-historic-state-of-the-union-address/',access:'unavailable-403'},
  {handle:'elonmusk',role:'테슬라·전기차·AI',identitySource:'https://ir.tesla.com/_flysystem/s3/sec/000156459022017214/tsla-8k_20220502-gen.pdf',access:'unavailable-403'},
  {handle:'KobeissiLetter',role:'시장·거시경제 논평',identitySource:'https://www.thekobeissiletter.com/about/feed',access:'original-posts-not-collected'},
  {handle:'DeItaone',role:'시장 속보 계정 후보',identitySource:null,access:'identity-verification-pending'}
];
export function socialContext(items,cutoff) {
  const unique=new Map();
  for(const item of evidenceAt(items,cutoff)) {
    if(!['community','social'].includes(item.kind)||item.originalVersionVerified!==true)continue;
    if(item.kind==='social'&&item.identityVerified!==true)continue;
    const text=String(item.title??'').replace(/\s+/g,' ').trim();
    if(!text)continue;
    const key=text.toLowerCase();
    if(!unique.has(key))unique.set(key,{url:item.url,title:text,kind:item.kind});
  }
  const posts=[...unique.values()];
  return {status:posts.length?'available':'unavailable',posts,count:posts.length,positive:posts.filter(p=>/상승|호재|강세|bullish|rally/i.test(p.title)).length,
    negative:posts.filter(p=>/하락|악재|약세|bearish|crash/i.test(p.title)).length,
    method:'중복 제거한 당시 확인 자료의 제목 기반 분위기 참고. 추천·조회·팔로워 수는 사용하지 않음'};
}
