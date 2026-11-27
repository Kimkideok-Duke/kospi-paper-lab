import { detectPatterns } from '../server/chart-patterns.mjs';

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
    if (!(row.price>0) || !Number.isFinite(row.regularStart) || !Number.isFinite(row.regularEnd) ||
        row.time<row.regularStart || row.time>=row.regularEnd) errors.push('정규장 시각·가격 확인 필요');
    if (row.candidate && (!Number.isFinite(row.candidate.signalTime) ||
        row.candidate.signalTime>row.time || !Number.isFinite(row.candidate.momentum))) errors.push('후보 선정 근거 시각 확인 필요');
    if (!Array.isArray(row.book?.asks) || !Array.isArray(row.book?.bids)) errors.push('호가 형태 확인 필요');
    if (typeof row.previousPrices!=='object' || row.previousAvailableAt>row.time ||
        !Number.isFinite(row.previousAvailableAt)) errors.push('직전 분석 가격 자료 누락');
    if (!Number.isFinite(row.time) || !Number.isFinite(row.availableAt) || row.availableAt > row.time) errors.push('스냅샷 당시 가용 시각 확인 필요');
    if (historicalContext(row,archive.events ?? []).status !== 'complete') errors.push('당시 뉴스·공시·구성종목 자료 누락');
    if (!row.book || !Number.isFinite(row.book.time) || row.book.time > row.time || row.time-row.book.time > 30000) errors.push('당시 유효 호가 누락');
  }
  return [...new Set(errors)];
}
