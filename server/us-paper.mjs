import { fresh, rate, percentage, weight } from "./engine.mjs";
import { executeUs, usAccount, usdQuoteMap, validFx } from "./us-engine.mjs";
import { collectOpeningNews, openingSignal, openingExitReason } from "./us-news.mjs";
import { recordAnalytics } from "./paper-analytics.mjs";
import { strategyPolicy, activateDailyPolicy } from "./strategy-policy.mjs";
import { recordReviewEvidence } from "./daily-review.mjs";
import { candleEvidence } from "./chart-patterns.mjs";
import { eventSignal, eventExitReason } from "./market-events.mjs";
import { markPaper } from "./paper-model.mjs";

const recent = (time, now, age = 90_000) => Number.isFinite(time) && time <= now + 3000 && now - time <= age;
export async function loadUsPrices(client, symbols) {
  const quotes = new Map();
  for (let i = 0; i < symbols.length; i += 200) {
    const rows = await client.get("prices", { symbols: symbols.slice(i, i + 200).join(",") });
    for (const [symbol, quote] of usdQuoteMap(rows)) quotes.set(symbol, quote);
  }
  return quotes;
}
async function assess(client, stock, slot, context) {
  const [series, book, warnings] = await Promise.all([
    client.get("candles", { symbol: stock.symbol, interval: "1m", count: 61 }, true),
    client.get("orderbook", { symbol: stock.symbol }, true),
    client.get("stocks/" + stock.symbol + "/warnings", {}, true),
  ]);
  const now = Date.now();
  if (!Array.isArray(warnings) || warnings.length || book?.currency !== "USD" || !recent(Date.parse(book.timestamp), now)) return null;
  const asks = book.asks?.filter(item => Number(item.price) > 0 && Number(item.volume) > 0).map(item => Number(item.price)) ?? [];
  const bids = book.bids?.filter(item => Number(item.price) > 0 && Number(item.volume) > 0).map(item => Number(item.price)) ?? [];
  const ask = Math.min(...asks), bid = Math.max(...bids);
  const spread = rate(ask, bid), policy = strategyPolicy(context.state);
  if (!Number.isFinite(spread) || spread < 0 || spread > policy.maximumSpreadPct || !(bid > 0 && ask >= bid)) return null;
  const candles = (series?.candles ?? []).filter(c => c.currency === "USD" && Date.parse(c.timestamp) >= slot.regularStart
    && recent(Date.parse(c.timestamp), now, 70 * 60_000) && Number(c.closePrice) > 0).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  if (candles.length < 3 || !recent(Date.parse(candles[0].timestamp), now, 3 * 60_000)) return null;
  const momentum = rate(stock.q.price, Number(candles[Math.min(candles.length - 1, 14)].closePrice));
  const amount = candles.slice(0, 15).reduce((sum, c) => sum + Math.max(0, Number(c.volume) || 0) * Number(c.closePrice), 0);
  if (!Number.isFinite(momentum) || momentum <= (stock.news.caution ? Math.max(0.45, policy.minimumMomentumPct) : policy.minimumMomentumPct) || amount < 20_000_000 / context.fx.rate) return null;
  if (stock.hourly !== null && stock.hourly < 0.2) return null;
  if (context.indexChange !== null && context.indexChange < -1.5 && (stock.hourly ?? momentum) < 0.65) return null;
  return { ...stock, momentum, patternEvidence: candleEvidence(series, now),
    score: stock.score + weight(momentum, 0, 3) - spread,
    reason: [stock.hourly !== null ? "직전 분석 " + percentage(stock.hourly) : null, "최근 분봉 " + percentage(momentum),
      "호가 간격 " + spread.toFixed(2) + "%", stock.news.reason, "거래 시점 환율로 원화 정산"].filter(Boolean).join(" · "),
    validPrice: price => Math.abs(rate(price, stock.q.price)) <= 0.8 };
}
export async function scanUs(state, slot, client, calendar) {
  if (Date.now() < slot.regularStart || (!slot.review && Date.now() >= slot.regularEnd)) {
    return { status: "outside", message: "미국 정규장 연속매매 시간이 아닙니다.", trades: [] };
  }
  if (state.universe?.date !== slot.date) {
    const listings = [];
    for (const market of ["NASDAQ", "NYSE", "AMEX"]) listings.push(...await client.get("stocks/all", { market, status: "ACTIVE" }));
    const allowed = new Set(["STOCK", "FOREIGN_STOCK", "DEPOSITARY_RECEIPT", "REIT", "ETF", "FOREIGN_ETF"]);
    const rows = listings.filter(row => /^[A-Za-z0-9.-]{1,20}$/.test(row.symbol) && row.name && allowed.has(row.securityType)
      && (row.securityType.includes("ETF") || row.isCommonShare !== false));
    const stocks = [...new Map(rows.map(row => [row.symbol, { symbol: row.symbol, name: row.name, marketCountry: "US",
      type: row.securityType.includes("ETF") ? "ETF" : "주식" }])).values()];
    if (!stocks.length) throw new Error("미국 주식·ETF 종목 목록을 가져오지 못했습니다.");
    state.universe = { date: slot.date, stocks };
  }
  const rankings = await client.get("rankings", { type: "MARKET_TRADING_AMOUNT", marketCountry: "US", duration: "realtime", count: 100 }, true);
  const freshRankings = recent(Date.parse(rankings?.rankedAt), Date.now(), 20 * 60_000);
  const ranked = new Map(freshRankings ? (rankings.rankings ?? []).filter(row => row.currency === "USD").map(row => [row.symbol, row]) : []);
  const universe = state.universe.stocks;
  const liquid = universe.filter(stock => ranked.has(stock.symbol));
  const symbols = [...new Set([...liquid.map(stock => stock.symbol), ...state.positions.map(p => p.symbol),
    ...(state.paperOrders ?? []).filter(o => ["PENDING", "PARTIAL_FILLED"].includes(o.status)).map(o => o.symbol), "SPY", "QQQ"])];
  const [quotes, currency, news] = await Promise.all([
    loadUsPrices(client, symbols),
    client.get("exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" }),
    slot.opening && !slot.review ? state.scans.findLast(log => log.news?.until === slot.regularStart)?.news
      ?? collectOpeningNews(calendar, slot, { until: slot.regularStart, previousClose: Date.parse(calendar.previousBusinessDay?.regularMarket?.endTime) }) : null,
  ]);
  const fx = validFx(currency, Date.now());
  const spy = quotes.get("SPY"), spyBase = Number(ranked.get("SPY")?.price?.basePrice);
  const indexChange = fresh(spy, Date.now(), slot.regularStart) && spyBase > 0 ? rate(spy.price, spyBase) : null;
  const previous = state.previous?.date === slot.date && (state.previous.index === slot.index - 1 || (slot.manual && state.previous.index === slot.index)) ? state.previous.prices : null;
  activateDailyPolicy(state, "US", Date.now());
  const context = { fx, indexChange, state };
  const candidates = [];
  const budget = usAccount(state).total / 5;
  const shortlisted = liquid.flatMap(stock => {
    const q = quotes.get(stock.symbol);
    if (state.positions.some(p => p.symbol === stock.symbol) || !fresh(q, Date.now(), slot.regularStart)
      || q.price * fx.rate > budget || q.price * fx.rate < 1000) return [];
    const hourly = rate(q.price, previous?.[stock.symbol]);
    const change = rate(q.price, Number(ranked.get(stock.symbol)?.price?.basePrice));
    const opening = openingSignal(news, stock), live = eventSignal(state, stock, Date.now());
    if (live.blocked || (slot.event && (!live.relevant || (state.eventWatch?.pending?.symbols?.length && !state.eventWatch.pending.symbols.includes(stock.symbol))))) return [];
    const signal = { ...opening, score: opening.score + live.score, caution: opening.caution || live.caution, relevant: opening.relevant || live.relevant, reason: [opening.reason, live.reason].filter(Boolean).join(" · ") };
    if (hourly !== null && hourly < -0.15) return [];
    if (hourly === null && (change === null ? !signal.relevant : change < 0.25 || change > 12)) return [];
    return [{ ...stock, q, hourly, news: signal, score: 2 * weight(hourly ?? 0, -3, 3)
      + 0.5 * weight(change ?? 0, -5, 5) + 0.25 * Math.log10(1 + Number(ranked.get(stock.symbol)?.tradingAmount ?? 0) * fx.rate / 1e8) + signal.score }];
  }).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  if (!slot.review) for (const stock of shortlisted.slice(0, 7)) {
    const candidate = await assess(client, stock, slot, context);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= 5) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  const interested = [...new Set([...state.positions.map(p => p.symbol), ...candidates.map(c => c.symbol),
    ...(state.paperOrders ?? []).filter(o => ["PENDING", "PARTIAL_FILLED"].includes(o.status)).map(o => o.symbol)])];
  const books = new Map();
  let fillFx = fx;
  if (interested.length) {
    const [latestQuotes, latestFx] = await Promise.all([loadUsPrices(client, interested), client.get("exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" })]);
    for (const symbol of interested) quotes.delete(symbol);
    for (const [symbol, q] of latestQuotes) quotes.set(symbol, q);
    fillFx = validFx(latestFx, Date.now());
    if (state.paperModel?.enabled && !slot.review) for (const symbol of interested) books.set(symbol, await client.get("orderbook", { symbol }));
  }
  const finish = Date.now();
  if (state.paperModel?.enabled) markPaper(state, "US", quotes, fillFx, finish);
  const baselineEquity = usAccount(state).total;
  const trades = executeUs(state, { now: finish, slot, quotes, fx: fillFx, candidates, previous, books, event: slot.event,
    openingExit: (position, price) => eventExitReason(state, position, price, previous?.[position.symbol], finish, "US") ?? (news ? openingExitReason(news, position, price, Number(ranked.get(position.symbol)?.price?.basePrice)) : null) });
  if (!slot.manual && !slot.review && finish < slot.regularEnd) state.previous = { date: slot.date, index: slot.index,
    prices: Object.fromEntries([...quotes].filter(([, q]) => fresh(q, finish, slot.regularStart)).map(([symbol, q]) => [symbol, q.price])) };
  const totals = usAccount(state);
  state.history.push({ time: finish, total: totals.total, fxRate: fillFx.rate });
  state.latest = { at: finish, observed: liquid.filter(stock => quotes.has(stock.symbol)).length, universe: universe.length,
    etfs: universe.filter(stock => stock.type === "ETF").length, fresh: [...quotes.values()].filter(q => fresh(q, finish, slot.regularStart)).length,
    candidates: candidates.length, index: spy?.price ?? null, indexChange, currency: fillFx.rate, currencyAt: fillFx.from, missing: [...client.missing],
    selection: "NASDAQ·NYSE·AMEX의 거래대금 상위 100종목 중 주식·ETF" };
  if (state.paperModel?.enabled) recordAnalytics(state, "US", finish, ["SPY", "QQQ"].flatMap(symbol => quotes.has(symbol)
    ? [{ symbol, name: symbol === "SPY" ? "SPY · S&P 500" : "QQQ · NASDAQ 100", price: quotes.get(symbol).price, time: quotes.get(symbol).time, fx: fillFx.rate }] : []), baselineEquity);
  recordReviewEvidence(state, "US", quotes, fillFx, finish, candidates);
  return { status: slot.review ? "review" : "ok", trades, totals, news,
    message: slot.review ? "미국장 마감 모의 계좌 평가를 기록했습니다."
      : finish >= slot.regularEnd ? "분석 중 미국장이 종료되어 모의 체결을 건너뛰었습니다."
      : trades.length ? trades.length + "건의 미국장 모의 거래를 기록했습니다."
      : !ranked.size ? "최신 미국장 거래대금 순위가 없어 신규 매수를 건너뛰었습니다."
      : "미국장 시세를 분석했습니다. 체결 조건을 충족한 거래가 없었습니다." };
}
