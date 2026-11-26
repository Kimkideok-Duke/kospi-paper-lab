// Analysis only. No imports from order execution or strategy policy.
export const PATTERN_VERSION = 'patterns-v1';
export const PATTERNS = {
  doubleBottom: '이중바닥', doubleTop: '이중천장', inverseHead: '역머리어깨', head: '머리어깨',
  triangleUp: '삼각수렴 상방 돌파', triangleDown: '삼각수렴 하방 돌파',
  fallingWedge: '하락쐐기 상방 돌파', risingWedge: '상승쐐기 하방 돌파',
};
const MINUTE = 60_000;

export function candleEvidence(series, capturedAt) {
  return { source: 'candles', capturedAt, points: (series?.candles ?? []).map(c => ({
    time: Date.parse(c.timestamp) + MINUTE, price: Number(c.closePrice),
  })).filter(p => Number.isFinite(p.time) && p.time <= capturedAt && p.price > 0).slice(0, 120) };
}

function cleanPoints(points, cutoff, lookback = 120) {
  const unique = new Map();
  for (const p of points ?? []) if (Number.isFinite(p.time) && p.time <= cutoff && p.time >= cutoff - lookback * MINUTE
    && Number.isFinite(p.price) && p.price > 0 && (!p.observedAt || p.observedAt <= cutoff)) unique.set(p.time, { time: p.time, price: p.price });
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export function detectPatterns(points, cutoff, { tolerance = 0.8, lookback = 120 } = {}) {
  const rows = cleanPoints(points, cutoff, lookback), signals = [];
  const unavailable = reason => ({ status: 'unavailable', reason, signals, points: rows });
  if (rows.length < 20) return unavailable('기준 시점 이전 가격 표본이 20개 미만입니다.');
  if (cutoff - rows.at(-1).time > 3 * MINUTE) return unavailable('진입 전 3분 이내의 가격이 없습니다.');
  if (rows.some((p, i) => i && p.time - rows[i - 1].time > 3 * MINUTE)) return unavailable('분석 구간에 3분을 초과하는 관측 공백이 있습니다.');
  const radius = 2, pivots = [];
  for (let i = radius; i < rows.length - radius; i++) {
    const price = rows[i].price, neighbors = rows.slice(i - radius, i + radius + 1).filter((_, j) => j !== radius);
    const high = neighbors.every(p => p.price < price), low = neighbors.every(p => p.price > price);
    if (!high && !low) continue;
    const pivot = { ...rows[i], index: i, kind: high ? 'high' : 'low' };
    const previous = pivots.at(-1);
    if (previous?.kind === pivot.kind) { if (high ? price > previous.price : price < previous.price) pivots[pivots.length - 1] = pivot; }
    else pivots.push(pivot);
  }
  const close = rows.at(-1).price, previous = rows.at(-2).price, buffer = .001;
  const similar = (a, b) => Math.abs(a - b) / ((a + b) / 2) * 100 <= tolerance;
  const crosses = (level, direction, previousLevel) => direction === 'bullish'
    ? close > level * (1 + buffer) && previous <= previousLevel * (1 + buffer)
    : close < level * (1 - buffer) && previous >= previousLevel * (1 - buffer);
  const add = (id, direction, level, anchors, previousLevel = level) => {
    if (crosses(level, direction, previousLevel)) signals.push({ id, name: PATTERNS[id], direction, level, time: rows.at(-1).time, anchors });
  };
  // All extrema need two subsequent observations; no future bars are used.
  const last3 = pivots.slice(-3);
  if (last3.length === 3) {
    const [a, b, c] = last3, depth = Math.abs(b.price - (a.price + c.price) / 2) / b.price;
    if (similar(a.price, c.price) && depth >= .01 && c.index - a.index >= 6) {
      if (a.kind === 'low') add('doubleBottom', 'bullish', b.price, last3);
      else add('doubleTop', 'bearish', b.price, last3);
    }
  }
  const last5 = pivots.slice(-5);
  if (last5.length === 5) {
    const [a, b, c, d, e] = last5, bullish = a.kind === 'low';
    const head = bullish ? c.price < Math.min(a.price, e.price) * .99 : c.price > Math.max(a.price, e.price) * 1.01;
    if (head && similar(a.price, e.price) && similar(b.price, d.price)) {
      const slope = (d.price - b.price) / (d.index - b.index), level = d.price + slope * (rows.length - 1 - d.index);
      add(bullish ? 'inverseHead' : 'head', bullish ? 'bullish' : 'bearish', level, last5, level - slope);
    }
  }
  const highs = pivots.filter(p => p.kind === 'high').slice(-3), lows = pivots.filter(p => p.kind === 'low').slice(-3);
  if (highs.length === 3 && lows.length === 3) {
    const fit = points => {
      const a = points[0], b = points.at(-1), slope = (b.price - a.price) / (b.index - a.index);
      return { slope, at: index => a.price + slope * (index - a.index), valid: points.every(p => similar(p.price, a.price + slope * (p.index - a.index))) };
    };
    const upper = fit(highs), lower = fit(lows), first = Math.max(highs[0].index, lows[0].index), last = rows.length - 1;
    const initialWidth = upper.at(first) - lower.at(first), width = upper.at(last) - lower.at(last);
    if (upper.valid && lower.valid && initialWidth > close * .01 && width > 0 && width < initialWidth * .8 && upper.slope < lower.slope) {
      if (upper.slope < 0 && lower.slope > 0) {
        add('triangleUp', 'bullish', upper.at(last), [...highs, ...lows], upper.at(last - 1));
        add('triangleDown', 'bearish', lower.at(last), [...highs, ...lows], lower.at(last - 1));
      } else if (upper.slope < 0 && lower.slope < 0) add('fallingWedge', 'bullish', upper.at(last), [...highs, ...lows], upper.at(last - 1));
      else if (upper.slope > 0 && lower.slope > 0) add('risingWedge', 'bearish', lower.at(last), [...highs, ...lows], lower.at(last - 1));
    }
  }
  return { status: 'available', reason: signals.length ? '조건에 맞는 신규 돌파 확인' : '조건에 맞는 신규 돌파 패턴 없음', signals, points: rows };
}

function evidenceFor(state, trade) {
  if (trade.patternEvidence) return trade.patternEvidence;
  return { source: 'observations', capturedAt: null, points: Object.values(state.reviewEvidence ?? {}).flatMap(e => e.points)
    .filter(p => p.symbol === trade.symbol && p.time <= trade.time && (!p.observedAt || p.observedAt <= trade.time)) };
}

export function archivePatternEvidence(state, now, candidates = []) {
  const bySymbol = new Map(candidates.map(c => [c.symbol, c.patternEvidence]));
  for (const trade of state.trades ?? []) {
    if (trade.side !== 'BUY' || trade.time !== now || trade.patternEvidence) continue;
    const snapshot = bySymbol.get(trade.symbol), fallback = evidenceFor(state, trade);
    const evidence = snapshot && snapshot.capturedAt <= trade.time && snapshot.points.length >= 20 ? snapshot : fallback;
    trade.patternEvidence = { source: evidence.source, capturedAt: now, version: PATTERN_VERSION,
      points: cleanPoints(evidence.points, trade.time) };
  }
}

export function completedCycles(trades) {
  const active = new Map(), complete = [], open = [];
  let unmatched = 0;
  for (const t of [...trades].sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id))) {
    if (!(t.quantity > 0)) continue;
    if (t.side === 'BUY') {
      const cycle = active.get(t.symbol) ?? { entry: t, buys: [], sells: [], quantity: 0, invalid: false };
      cycle.buys.push(t); cycle.quantity += t.quantity; active.set(t.symbol, cycle);
    } else if (t.side === 'SELL') {
      const cycle = active.get(t.symbol);
      if (!cycle) { unmatched++; continue; }
      cycle.sells.push(t); cycle.quantity -= t.quantity;
      if (cycle.quantity < 0) cycle.invalid = true;
      if (cycle.quantity <= 0) { complete.push(cycle); active.delete(t.symbol); }
    }
  }
  open.push(...active.values());
  return { complete, open, unmatched };
}

export function patternReport(state, market, options = {}) {
  const mode = options.mode ?? 'avoid-bearish', tolerance = options.tolerance ?? .8, lookback = options.lookback ?? 120;
  if (!['avoid-bearish', 'require-bullish'].includes(mode) || ![.4, .8, 1.2].includes(tolerance) || ![60, 120].includes(lookback)) throw new Error('잘못된 차트패턴 분석 조건입니다.');
  const selection = options.pattern ?? 'all';
  if (selection !== 'all' && !Object.hasOwn(PATTERNS, selection)) throw new Error('잘못된 차트패턴 종류입니다.');
  const { complete, open, unmatched } = completedCycles(state.trades ?? []);
  const rows = complete.map(cycle => {
    const t = cycle.entry, evidence = evidenceFor(state, t), analysis = detectPatterns(evidence.points, t.time, { tolerance, lookback });
    const signals = analysis.signals.filter(s => selection === 'all' || s.id === selection);
    const bullish = signals.some(s => s.direction === 'bullish'), bearish = signals.some(s => s.direction === 'bearish');
    const netKnown = cycle.sells.every(s => Number.isFinite(s.realized));
    const baseline = netKnown ? cycle.sells.reduce((sum, s) => sum + s.realized, 0) : null;
    const valid = !cycle.invalid && netKnown && analysis.status === 'available';
    const keep = mode === 'require-bullish' ? bullish && !bearish : !bearish;
    return { id: t.id, symbol: t.symbol, name: t.name, entryTime: t.time, exitTime: cycle.sells.at(-1).time,
      quantity: cycle.buys.reduce((sum, b) => sum + b.quantity, 0), fillCount: cycle.buys.length + cycle.sells.length,
      entryPrice: market === 'US' ? t.priceUsd : t.price, baseline, simulated: valid ? keep ? baseline : 0 : null,
      difference: valid ? keep ? 0 : -baseline : null, decision: valid ? keep ? 'keep' : 'skip' : 'unavailable',
      reason: cycle.invalid ? '매수·매도 수량이 일치하지 않습니다.' : !netKnown ? '매도 실현손익 기록이 없습니다.' : analysis.reason,
      signals, evidenceSource: evidence.source, points: analysis.points, costsKnown: [...cycle.buys, ...cycle.sells].every(s => !!s.costs) };
  });
  const comparable = rows.filter(r => r.decision !== 'unavailable'), total = key => comparable.reduce((sum, r) => sum + r[key], 0);
  const perPattern = Object.entries(PATTERNS).map(([id, name]) => {
    const sample = comparable.filter(r => r.signals.some(s => s.id === id));
    return { id, name, count: sample.length, baseline: sample.reduce((n, r) => n + r.baseline, 0), difference: sample.reduce((n, r) => n + r.difference, 0) };
  });
  return { market, version: PATTERN_VERSION, options: { mode, tolerance, lookback, pattern: selection },
    summary: { completed: rows.length, comparable: comparable.length, unavailable: rows.length - comparable.length, open: open.length, unmatched,
      kept: comparable.filter(r => r.decision === 'keep').length, skipped: comparable.filter(r => r.decision === 'skip').length,
      baseline: comparable.length ? total('baseline') : null, simulated: comparable.length ? total('simulated') : null,
      difference: comparable.length ? total('difference') : null }, rows, perPattern };
}
