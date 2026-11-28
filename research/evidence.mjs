import { detectPatterns } from '../server/chart-patterns.mjs';

// Quote arrays are not guaranteed to arrive in best-price order. Preserve the
// original input, reject malformed depth, and share one canonical view in replay.
export function researchBook(book) {
  if(!book || !Array.isArray(book.asks) || !Array.isArray(book.bids))return null;
  const numeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
  function levels(rows,direction){
    if(!rows.length||rows.some(r=>!r||!numeric(r.price)||Number(r.price)<=0||!numeric(r.volume)||!Number.isSafeInteger(Number(r.volume))||Number(r.volume)<0))return null;
    const prices=rows.map(r=>Number(r.price));if(new Set(prices).size!==prices.length)return null;
    return rows.map(r=>({price:Number(r.price),volume:Number(r.volume)})).sort((a,b)=>direction*(a.price-b.price));
  }
  const asks=levels(book.asks,1),bids=levels(book.bids,-1);
  return asks&&bids?{time:book.time,asks,bids}:null;
}
export function researchSpread(book){
  const ask=book?.asks.find(r=>r.volume>0),bid=book?.bids.find(r=>r.volume>0);
  // A crossed integrated quote can occur in the source. The current paper
  // engine cannot execute it, so it must not become an eligible research entry.
  return ask&&bid&&ask.price>=bid.price?(ask.price/bid.price-1)*100:null;
}

// Items require an immutable version timestamp. Corrected articles must be separate items.
export function evidenceAt(items, cutoff) {
  return items.filter(item => Number.isFinite(item.publishedAt) &&
    Number.isFinite(item.availableAt) && Number.isFinite(item.versionAt) &&
    Math.max(item.publishedAt,item.availableAt,item.versionAt) <= cutoff &&
    typeof item.url === 'string' && /^https:\/\//.test(item.url));
}
export function historicalContext(snapshot, events, pattern = false) {
  const time = snapshot.time;
  const coverage = snapshot.coverage;
  const complete = coverage?.news === 'complete' && coverage?.disclosures === 'complete' &&
    coverage?.universe === 'point-in-time' && coverage?.from <= time && coverage?.until >= time;
  const items = evidenceAt(events,time).filter(item => item.symbol === snapshot.symbol || item.symbol === 'MARKET');
  const points = (snapshot.points ?? []).filter(p => p.time <= time && p.observedAt <= time);
  return {
    status:complete ? 'complete' : 'missing-evidence',
    news:items.filter(i => i.kind === 'news'),
    disclosures:items.filter(i => i.kind === 'disclosure'),
    pattern:pattern ? detectPatterns(points,time) : null
  };
}
export function validateArchive(archive) {
  const errors = [];
  if (archive.market !== 'KR' || archive.start !== '2026-05-01') errors.push('시장·시작일 확인 필요');
  if (!Array.isArray(archive.snapshots) || !archive.snapshots.length) errors.push('과거 분봉·호가·후보 스냅샷 없음');
  if ((archive.snapshots ?? []).length && (!Array.isArray(archive.sessionDates) ||
      !archive.sessionDates.length || archive.sessionDates.some(date=>!archive.snapshots.some(r=>r.date===date)))) {
    errors.push('전 거래일 수집 범위 확인 필요');
  }
  for (const row of archive.snapshots ?? []) {
    if (!(row.price>0) || !Number.isFinite(row.price) || !Number.isFinite(row.regularStart) || !Number.isFinite(row.regularEnd) ||
        row.time<row.regularStart || row.time>=row.regularEnd) errors.push('정규장 시각·가격 확인 필요');
    if (row.candidate && (!Number.isFinite(row.candidate.signalTime) ||
        row.candidate.signalTime>row.time || !Number.isFinite(row.candidate.momentum))) errors.push('후보 선정 근거 시각 확인 필요');
    if (!researchBook(row.book)) errors.push('호가 가격·잔량·중복 단계 확인 필요');
    if (!row.previousPrices || typeof row.previousPrices!=='object' || Array.isArray(row.previousPrices) || row.previousAvailableAt>row.time ||
        !Number.isFinite(row.previousAvailableAt)) errors.push('직전 분석 가격 자료 누락');
    if (!Number.isFinite(row.time) || !Number.isFinite(row.availableAt) || row.availableAt > row.time) errors.push('스냅샷 당시 가용 시각 확인 필요');
    if (historicalContext(row,archive.events ?? []).status !== 'complete') errors.push('당시 뉴스·공시·구성종목 자료 누락');
    if (!row.book || !Number.isFinite(row.book.time) || row.book.time > row.time || row.time-row.book.time > 30000) errors.push('당시 유효 호가 누락');
  }
  return [...new Set(errors)];
}
