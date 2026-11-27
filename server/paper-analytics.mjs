import { paperTotal, upgradePaper, activeOrder } from "./paper-model.mjs";
const day = (now, market) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: market === "US" ? "America/New_York" : "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
export function recordAnalytics(state, market, now, benchmarks = [], baselineEquity = null) {
  upgradePaper(state, market, now);
  const total = paperTotal(state, market), date = day(now, market);
  const peak = state.operations.equityPeak ?? Math.max(10_000_000, ...state.history.map(p => p.total).filter(Number.isFinite));
  state.operations.equityPeak = Math.max(peak, total);
  state.operations.maxDrawdownPct = Math.max(state.operations.maxDrawdownPct ?? 0, (state.operations.equityPeak - total) / state.operations.equityPeak * 100);
  let row = state.daily.find(item => item.date === date);
  if (!row) { row = { date, open: baselineEquity ?? total, high: Math.max(baselineEquity ?? total, total), low: Math.min(baselineEquity ?? total, total), close: total, time: now }; state.daily.push(row); }
  row.high = Math.max(row.high, total); row.low = Math.min(row.low, total); row.close = total; row.time = now;
  state.benchmarks ??= {};
  for (const quote of benchmarks) {
    if (!(quote.price > 0 && quote.fx > 0) || !Number.isFinite(quote.time) || now - quote.time > 90_000 || quote.time > now + 3000) continue;
    let b = state.benchmarks[quote.symbol];
    if (!b) {
      b = { symbol: quote.symbol, name: quote.name, since: now, basePrice: quote.price, baseFx: quote.fx, baseStrategy: baselineEquity ?? total, points: [] };
      state.benchmarks[quote.symbol] = b;
    }
    b.price = quote.price; b.fx = quote.fx; b.time = quote.time;
    b.returnPct = (quote.price * quote.fx / (b.basePrice * b.baseFx) - 1) * 100;
    b.strategyPct = (total / b.baseStrategy - 1) * 100;
    const point = { time: now, benchmarkPct: b.returnPct, strategyPct: b.strategyPct };
    if (b.points.length && now - b.points.at(-1).time < 60_000) b.points[b.points.length - 1] = point; else b.points.push(point);
  }
  state.operations ??= {};
  state.operations.lastValuation = now;
}
export function analyticsView(state, market) {
  const total = paperTotal(state, market);
  const history = [{ time: 0, total: 10_000_000 }, ...state.history, ...state.trades.map(t => ({ time: t.time, total: t.total }))]
    .filter(p => Number.isFinite(p.total)).sort((a, b) => a.time - b.time);
  let peak = 10_000_000, maxDrawdownPct = 0;
  for (const point of [...history, { total }]) { peak = Math.max(peak, point.total); if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.total) / peak * 100); }
  maxDrawdownPct = Math.max(maxDrawdownPct, state.operations?.maxDrawdownPct ?? 0);
  const sells = state.trades.filter(t => t.side === "SELL" && Number.isFinite(t.realized));
  const wins = sells.filter(t => t.realized > 0), losses = sells.filter(t => t.realized < 0);
  const profit = wins.reduce((sum, t) => sum + t.realized, 0), loss = -losses.reduce((sum, t) => sum + t.realized, 0);
  let streak = 0, maxLossStreak = 0;
  for (const trade of sells) { streak = trade.realized < 0 ? streak + 1 : 0; maxLossStreak = Math.max(streak, maxLossStreak); }
  const costs = state.costs ?? { commission: 0, transactionTax: 0, fxSpread: 0, slippage: 0 };
  const explicitCosts = costs.commission + costs.transactionTax + costs.fxSpread;
  let pricePnl = 0, fxPnl = 0, attributedRealized = 0, openPnl = 0;
  for (const trade of sells.filter(t => t.strategyVersion)) {
    pricePnl += trade.priceEffectKrw ?? 0; fxPnl += trade.fxEffectKrw ?? 0; attributedRealized += trade.realized;
  }
  for (const p of state.positions) {
    const value = market === "US" ? p.valueKrw : Math.floor(p.price * p.quantity);
    const cost = p.costKrw ?? p.entry * p.quantity;
    openPnl += value - cost;
    if (market === "US") {
      const native = p.nativeCost ?? p.entryUsd * p.quantity, entryFx = p.entryFx ?? cost / native;
      pricePnl += Math.round((p.priceUsd * p.quantity - native) * entryFx);
      fxPnl += Math.round(p.priceUsd * p.quantity * ((p.fxRate ?? entryFx) - entryFx));
    } else pricePnl += value - (p.entryGrossKrw ?? cost);
  }
  // Annual provision is an estimate for this simulated account only, never deducted twice from cash.
  const yearly = {};
  if (market === "US") for (const trade of sells) {
    const year = new Date(trade.time).getUTCFullYear(); yearly[year] = (yearly[year] ?? 0) + trade.realized;
  }
  const estimatedCapitalTax = Object.values(yearly).reduce((sum, value) => sum + Math.floor(Math.max(0, value - 2_500_000) * 0.22), 0);
  const daily = (state.daily ?? []).map((row, index, rows) => ({ ...row, pnl: row.close - (rows[index - 1]?.close ?? row.open),
    returnPct: ((row.close / (rows[index - 1]?.close ?? row.open)) - 1) * 100 }));
  return { entryComparisons: (state.entryObservations ?? []).slice(-100).map(row => ({ ...row,
    forwardReturnPct: row.afterPrice > 0 ? (row.afterPrice / row.price - 1) * 100 : null })),
    maxDrawdownPct, tradeCount: state.trades.length, sellFillCount: sells.length,
    winRate: sells.length ? wins.length / sells.length * 100 : null, averageWin: wins.length ? profit / wins.length : null,
    averageLoss: losses.length ? loss / losses.length : null, profitFactor: loss ? profit / loss : null,
    maxLossStreak, costs, explicitCosts, pnlBeforeExplicitCosts: total - 10_000_000 + explicitCosts,
    estimatedCapitalTax, afterEstimatedTax: total - estimatedCapitalTax,
    attribution: { pricePnl, fxPnl, costPnl: attributedRealized + openPnl - pricePnl - fxPnl,
      total: attributedRealized + openPnl, legacyRealized: sells.filter(t => !t.strategyVersion).reduce((sum, t) => sum + t.realized, 0) },
    daily, benchmarks: Object.values(state.benchmarks ?? {}).map(b => ({ ...b, points: b.points.slice(-500) })),
    versions: (state.versions ?? []).map((v, i, all) => {
      const fills = state.trades.filter(t => t.strategyVersion === v.id);
      const end = all[i + 1];
      return { ...v, endTime: end?.time ?? null, fillCount: fills.length,
        realized: fills.filter(t => t.side === "SELL").reduce((sum, t) => sum + t.realized, 0),
        periodReturn: v.baseline > 0 ? ((end?.baseline ?? total) / v.baseline - 1) * 100 : null };
    }), model: state.paperModel ?? null,
    pendingOrders: (state.paperOrders ?? []).filter(activeOrder), orders: (state.paperOrders ?? []).slice(-100).reverse(),
    alerts: (state.alerts ?? []).slice(-50).reverse(), operations: state.operations ?? {},
    notes: "기존 거래는 소급 변경하지 않음 · 벤치마크는 표시된 측정 시작 이후의 원화 가격수익률(비용·배당 제외) · 통계는 매도 체결별 기준 · 해외 양도세는 이 모의계좌만의 연간 공제 250만원·22% 추정, 현금 미차감 · ETF 보유기간 과세·배당세·미국 제비용 등 미포함" };
}
