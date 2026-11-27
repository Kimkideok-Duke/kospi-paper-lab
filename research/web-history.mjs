const clean=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
export function parseDart(html,date) {
  const items=[];
  for(const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row=match[1];
    const receipt=row.match(/href="(\/dsaf001\/main.do\?rcpNo=\d+)"/);
    if(!receipt)continue;
    const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>clean(m[1]));
    const time=cells[0]?.match(/\b\d{2}:\d{2}\b/)?.[0];
    const title=row.match(/id="r_\d+"[\s\S]*?>([\s\S]*?)<\/a>/)?.[1];
    if(!time||!title||!cells.includes(date.replaceAll('-','.')))continue;
    const stamp=Date.parse(date+'T'+time+':00+09:00');
    items.push({kind:'disclosure',company:cells[1],title:clean(title),source:'DART',market:'KR-KOSPI',
      url:'https://dart.fss.or.kr'+receipt[1],publishedAt:stamp,availableAt:stamp+60000,versionAt:stamp+60000,precision:"minute",
      evidenceGrade:'official-receipt-metadata',bodyVerified:false});
  }
  return {items,total:Number(html.match(/id="totalCnt"[^>]*value="(\d+)"/)?.[1]??NaN)};
}
export function parseNews(html,date) {
  const items=[];
  for(const block of html.split(/<div class="mduSubjectList">/).slice(1)) {
    const url=block.match(/href="(\/\/news.nate.com\/view\/\d{8}n\d+[^"]*)"/)?.[1];
    const title=block.match(/<h2 class="tit">([\s\S]*?)<\/h2>/)?.[1];
    const medium=block.match(/<span class="medium">([\s\S]*?)<em>([^<]+)<\/em>/);
    if(!url||!title)continue;
    const time=medium?.[2]?.match(/(\d{2})-(\d{2}) (\d{2}:\d{2})/);
    const listedAt=time?Date.parse(date.slice(0,4)+'-'+time[1]+'-'+time[2]+'T'+time[3]+':00+09:00'):null;
    items.push({kind:'news',title:clean(title),source:clean(medium?.[1]),url:'https:'+url.replaceAll('&amp;','&'),
      archiveDate:date,listedAt,publishedAt:null,availableAt:null,versionAt:null,
      evidenceGrade:'index-only',bodyVerified:false,
      changedDate:time?time[1]+'-'+time[2]!==date.slice(5):null});
  }
  const pages=[...html.matchAll(/href="([^"]*subsection\?[^"]*page=(\d+)[^"]*)"/g)]
    .filter(m=>m[1].includes('date='+date.replaceAll('-',''))).map(m=>({url:new URL(m[1].replaceAll('&amp;','&'),'https://news.nate.com').href,page:Number(m[2])}));
  return {items,pages};
}
export function parseNewsDetail(html) {
  const meta = name => html.match(new RegExp('<meta[^>]+name="'+name+'"[^>]+content="([^"]*)"','i'))?.[1];
  const published = meta('nate-rcm:pub');
  const modified = html.match(/(?:기사수정|최종수정|수정일)[\s\S]{0,80}?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1];
  const publishedAt=Date.parse(published);
  const modifiedAt=modified?Date.parse(modified.replace(' ','T')+':00+09:00'):null;
  return {publishedAt:Number.isFinite(publishedAt)?publishedAt:null,
    modifiedAt:Number.isFinite(modifiedAt)?modifiedAt:null,
    title:meta('nate-rcm:tit')??null,
    excerpt:(meta('nate-rcm:sum')??'').slice(0,200),
    evidenceGrade:'publication-time-proxy',originalVersionVerified:false};
}
export function dartDocumentUrl(html) {
  const match=html.match(/viewDoc\("(\d+)",\s*"(\d+)",\s*"(\d+)",\s*"(\d+)",\s*"(\d+)",\s*"([A-Z0-9]+)"/);
  if(!match)return null;
  return 'https://dart.fss.or.kr/report/viewer.do?'+new URLSearchParams(Object.fromEntries(
    ['rcpNo','dcmNo','eleId','offset','length','dtd'].map((key,i)=>[key,match[i+1]])));
}
