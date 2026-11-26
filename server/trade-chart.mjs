import { marketDate } from './strategy-policy.mjs';
import { completedCycles } from './chart-patterns.mjs';

const MINUTE = 60_000;
const validPoint = p => Number.isFinite(p?.time) && Number.isFinite(p.price) && p.price > 0;
const nativePrice = (trade, market) => market === 'US' ? trade.priceUsd : trade.price;

function cycles(state) {
  const result = completedCycles(state.trades ?? []);
  return [...result.complete, ...result.open];
}

// Retain existing observations for each round trip, without additional market requests.
export function recordTradeCharts(state, market, quotes, now) {
  for (const cycle of cycles(state)) {
    const exit = cycle.quantity <= 0 ? cycle.sells.at(-1)?.time : null;
    if (exit && now > exit + 30 * MINUTE) continue;
    const q = quotes.get(cycle.entry.symbol);
    if (!validPoint(q) || q.time < cycle.entry.time || q.time > now || now - q.time > 90_000) continue;
    state.tradeCharts ??= {};
    const saved = state.tradeCharts[cycle.entry.id] ??= { symbol: cycle.entry.symbol, points: [], sampled: false };
    const point = { time: q.time, price: q.price, source: "monitor-5s" };
    const last = saved.points.at(-1);
    if (last && last.time >= point.time) continue;
    if (last && Math.floor(last.time / 5000) === Math.floor(point.time / 5000)) saved.points[saved.points.length - 1] = point;
    else saved.points.push(point);
    if (saved.points.length > 40000) {
      saved.points = saved.points.filter((_, i, a) => i % 2 === 0 || i === a.length - 1);
      saved.sampled = true;
    }
  }
}

export function tradeChart(state, market, id, now = Date.now(), date = null) {
  const selected = (state.trades ?? []).find(t => String(t.id) === String(id));
  if (!selected || (date && marketDate(selected.time, market) !== date)) return null;
  const cycle = cycles(state).find(c => [...c.buys, ...c.sells].some(t => String(t.id) === String(id)));
  const trades = date ? state.trades.filter(t=>t.symbol===selected.symbol && marketDate(t.time,market)===date) : cycle ? [...cycle.buys, ...cycle.sells] : [selected];
  trades.sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id));
  const first = cycle?.entry.time ?? selected.time, exit = cycle && cycle.quantity <= 0 ? cycle.sells.at(-1).time : null;
  const from = first - 120 * MINUTE, until = exit ? Math.min(now, exit + 30 * MINUTE) : now;
  const saved = cycle ? state.tradeCharts?.[cycle.entry.id] : null;
  const candidates = [
    ...(date ? Object.values(state.tradeCharts??{}).filter(c=>c.symbol===selected.symbol).flatMap(c=>c.points??[]) : []),
    ...(saved?.points ?? []),
    ...Object.values(state.reviewEvidence ?? {}).flatMap(e => (e.points ?? []).filter(p => p.symbol === selected.symbol)),
    ...trades.flatMap(t => t.patternEvidence?.points ?? []),
  ];
  const map = new Map();
  for (const p of candidates) if (validPoint(p) && (date ? marketDate(p.time,market)===date && p.time<=now : p.time >= from && p.time <= until)) {
    // Prefer the observations retained for this cycle over an older candle close at the same instant.
    if (!map.has(p.time)) map.set(p.time, { time: p.time, price: p.price, source: p.source??"saved" });
  }
  const points = [...map.values()].sort((a, b) => a.time - b.time);
  let gaps = 0;
  for (let i = 1; i < points.length; i++) if (points[i].time - points[i - 1].time > 3 * MINUTE) gaps++;
  return { market, date, symbol: selected.symbol, name: selected.name, currency: market === 'US' ? 'USD' : 'KRW', selectedId: String(selected.id),
    open: date ? null : cycle ? cycle.quantity > 0 : null, sampled: date ? Object.values(state.tradeCharts??{}).some(c=>c.symbol===selected.symbol&&c.sampled) : saved?.sampled ?? false, points, gaps,
    trades: trades.map(t => ({ id: String(t.id), time: t.time, side: t.side, quantity: t.quantity,
      price: Number.isFinite(nativePrice(t, market)) ? nativePrice(t, market) : null,
      reason: t.reason ?? '', realized: t.realized ?? null, fxRate: market === 'US' ? t.fxRate ?? null : null })),
    note: points.length < 2 ? '저장된 가격 경로가 부족합니다. 확인된 체결 지점만 표시합니다.'
      : '실선은 저장된 관측가·진입 전 1분봉 종가, 회색 점선은 3분 초과 미관측 구간입니다. 점선 구간의 실제 가격은 확인되지 않았습니다.',
  };
}
