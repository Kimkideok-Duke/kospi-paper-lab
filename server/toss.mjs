import { account, execute, fresh, kst, marketPhase, percentage, quoteMap, rate, weight } from "./engine.mjs";
import { collectOpeningNews, openingExitReason, openingSignal } from "./us-news.mjs";
import { recordAnalytics } from "./paper-analytics.mjs";
import { markPaper } from "./paper-model.mjs";
import { marketTransport, MarketTransportError } from "./market-transport.mjs";

const MARKET = "/api/v1/";
const nearby = (time, now, age) => Number.isFinite(time) && time <= now + 3000 && now - time <= age;
const safeNumber = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export class TossError extends Error {
  constructor(status, auth, context = {}) {
    const details = {
      400: "토스증권이 요청을 거절했습니다. API 설정을 확인해 주세요.",
      401: auth ? "Client ID 또는 Client Secret을 확인해 주세요." : "토스증권 액세스 토큰 인증에 실패했습니다.",
      403: "토스증권이 이 서버의 접근을 거절했습니다. API 권한과 허용 IP를 확인해 주세요.",
      429: "토스증권 " + (context.group === "STOCK_ALL" ? "종목 목록 " : "") + "조회 한도로 잠시 대기 중입니다.",
    };
    super(details[status] ?? "토스증권 시세를 가져오지 못했습니다.");
    this.status = status;
    this.group = context.group ?? null; this.endpoint = context.endpoint ?? null; this.retryAfter = context.retryAfter ?? null;
  }
}

async function tossFetch(path, options) {
  try {
    return await marketTransport.request(path, options);
  } catch (error) {
    if (error instanceof MarketTransportError) throw new TossError(error.status, path === "/oauth2/token", error);
    throw error;
  }
}

export async function issue({ id, secret }) {
  const token = await tossFetch("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!token.access_token || !(Number(token.expires_in) > 0)) throw new Error("토스증권 토큰 응답을 읽을 수 없습니다.");
  return { value: token.access_token, expires: Date.now() + Number(token.expires_in) * 1000 };
}

export function marketClient(token, options = {}) {
  let requests = 0;
  const missing = new Set();
  async function get(path, params = {}, optional = false) {
    if (optional && requests >= 44) {
      missing.add("일부 보조 조회 호출 한도");
      return null;
    }
    requests += 1;
    const endpoint = MARKET + path + "?" + new URLSearchParams(params);
    try {
      const data = await tossFetch(endpoint, { headers: { authorization: "Bearer " + token } });
      if (!Object.hasOwn(data, "result")) throw new Error("토스증권 응답을 읽을 수 없습니다.");
      return data.result;
    } catch (error) {
      if (!optional || [401, 403].includes(error.status)) throw error;
      missing.add(path.replace(/stocks\/[A-Z0-9]+\//, "종목 "));
      return null;
    }
  }
  return { get, get requests() { return requests; }, missing };
}

export async function loadPrices(client, symbols) {
  const prices = new Map();
  for (let start = 0; start < symbols.length; start += 600) {
    const group = [];
    for (let offset = start; offset < Math.min(start + 600, symbols.length); offset += 200) {
      group.push(client.get("prices", { symbols: symbols.slice(offset, offset + 200).join(",") }));
    }
    for (const results of await Promise.all(group)) {
      for (const [symbol, quote] of quoteMap(results)) prices.set(symbol, quote);
    }
  }
  return prices;
}

function orderbookSpread(book, now) {
  if (!nearby(Date.parse(book?.timestamp), now, 90_000)) return null;
  const ask = safeNumber(book.asks?.[0]?.price);
  const bid = safeNumber(book.bids?.[0]?.price);
  if (!(bid > 0) || !(ask > bid) || !(Number(book.asks[0].volume) > 0) || !(Number(book.bids[0].volume) > 0)) return null;
  return rate(ask, bid);
}

function minuteStats(series, now, regularStart, price) {
  const candles = (series?.candles ?? []).filter(c => {
    const time = Date.parse(c.timestamp);
    return time >= regularStart && nearby(time, now, 70 * 60_000) && Number(c.closePrice) > 0;
  });
  if (candles.length < 3 || !nearby(Date.parse(candles[0].timestamp), now, 3 * 60_000)) return null;
  const prior = Number(candles[Math.min(candles.length - 1, 14)].closePrice);
  const volume = candles.slice(0, 15).reduce((sum, candle) => sum + (safeNumber(candle.volume) ?? 0), 0);
  return { momentum: rate(price, prior), amount: volume * price };
}

function shortlist(universe, quotes, prior, context, now, start, held, budget) {
  const candidates = [];
  for (const stock of universe) {
    const q = quotes.get(stock.symbol);
    if (held.has(stock.symbol) || !fresh(q, now, start) || q.price > budget || q.price < 1000) continue;
    const sessionChange = rate(q.price, context.ranked.get(stock.symbol)?.price?.basePrice);
    const hourly = rate(q.price, prior?.[stock.symbol]);
    const news = openingSignal(context.news, stock);
    if (hourly !== null && hourly < -0.15) continue;
    if (hourly === null && sessionChange !== null && (sessionChange < 0.25 || sessionChange > 12)) continue;
    if (hourly === null && sessionChange === null && !news.relevant) continue;
    const amount = Number(context.ranked.get(stock.symbol)?.tradingAmount ?? 0);
    const score = 2 * weight(hourly ?? 0, -3, 3) + 0.5 * weight(sessionChange ?? 0, -5, 5)
      + 0.25 * Math.log10(1 + amount / 100_000_000) + news.score;
    candidates.push({ ...stock, q, hourly, sessionChange, score, news });
  }
  return candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

async function assess(client, stock, slot, phaseStart, context) {
  const symbol = stock.symbol;
  const path = "stocks/" + symbol + "/";
  const [series, book, warnings, limits] = await Promise.all([
    client.get("candles", { symbol, interval: "1m", count: 61 }, true),
    client.get("orderbook", { symbol }, true),
    client.get(path + "warnings", {}, true),
    client.get("price-limits", { symbol }, true),
  ]);
  const now = Date.now();
  const limitTime = Date.parse(limits?.timestamp);
  if (!Array.isArray(warnings) || warnings.length || !Number.isFinite(limitTime) || kst(limitTime).slice(0, 10) !== slot.date) return null;
  const spread = orderbookSpread(book, now);
  const candles = minuteStats(series, now, phaseStart, stock.q.price);
  const minimumMomentum = stock.news.caution ? 0.45 : 0.15;
  if (spread === null || spread > 0.65 || !candles || candles.amount < 20_000_000 || candles.momentum <= minimumMomentum) return null;
  if (stock.hourly !== null && stock.hourly < 0.2) return null;
  if (context.indexChange !== null && context.indexChange < -1.5 && (stock.hourly ?? candles.momentum) < 0.65) return null;
  const upper = Number(limits.upperLimitPrice);
  const lower = Number(limits.lowerLimitPrice);
  if (!(upper > stock.q.price) || !(lower < stock.q.price) || !(lower > 0)) return null;
  const [investor, program, trades] = await Promise.all([
    client.get(path + "investor-trading", { count: 1 }, true),
    client.get(path + "program-trades", { count: 1 }, true),
    client.get("trades", { symbol, count: 20 }, true),
  ]);
  const flow = investor?.records?.[0];
  const institutional = flow?.date === slot.date
    ? (safeNumber(flow.foreigner?.netBuyVolume) ?? 0) + (safeNumber(flow.institution?.netBuyVolume) ?? 0) : null;
  const programFlow = program?.records?.[0];
  const programNet = programFlow?.date === slot.date
    ? (safeNumber(programFlow.arbitrage?.netBuyVolume) ?? 0) + (safeNumber(programFlow.nonArbitrage?.netBuyVolume) ?? 0) : null;
  const prints = Array.isArray(trades) ? trades.filter(item => nearby(Date.parse(item.timestamp), Date.now(), 90_000)) : null;
  if (prints && prints.length === 0) return null;
  const reason = [
    stock.hourly !== null ? (slot.manual ? "최근 정기 분석 " : "직전 시간 ") + percentage(stock.hourly) : null,
    "최근 분봉 " + percentage(candles.momentum),
    "호가 간격 " + spread.toFixed(2) + "%",
    institutional ? (institutional > 0 ? "외국인·기관 순매수" : "외국인·기관 순매도") + " " + Math.abs(institutional).toLocaleString("ko-KR") + "주" : null,
    stock.news.reason ? stock.news.reason + " 반영" : null,
  ].filter(Boolean).join(" · ");
  return {
    ...stock, reason,
    score: stock.score + weight(candles.momentum, 0, 3) - spread
      + Math.sign(institutional ?? 0) * 0.2 + Math.sign(programNet ?? 0) * 0.1,
    validPrice: price => price > lower && price < upper && Math.abs(rate(price, stock.q.price)) <= 0.8,
  };
}

export async function scan(state, slot, client, now) {
  if (state.calendar?.date !== slot.date) {
    state.calendar = { date: slot.date, result: await client.get("market-calendar/KR", { date: slot.date }) };
  }
  const day = state.calendar.result;
  const phase = marketPhase(day, now, slot);
  if (phase === "closed") {
    const status = day?.today?.date === slot.date && day.today.integrated?.regularMarket ? "outside" : "closed";
    return { status, message: status === "closed" ? "토스증권 장 운영 일정상 휴장일입니다." : "정규장 연속매매 시간이 아닙니다." };
  }

  if (state.universe?.date !== slot.date) {
    const listed = await client.get("stocks/all", { market: "KOSPI", status: "ACTIVE" });
    const allowed = new Set(["STOCK", "FOREIGN_STOCK", "DEPOSITARY_RECEIPT", "REIT", "INFRASTRUCTURE_FUND", "ETF", "FOREIGN_ETF"]);
    const stocks = Array.isArray(listed) && listed.filter(row => allowed.has(row.securityType)
      && /^[A-Z0-9]{6}$/.test(row.symbol) && row.name)
      .map(row => ({ symbol: row.symbol, name: row.name, type: row.securityType.includes("ETF") ? "ETF" : "주식" }));
    if (!stocks?.length) throw new Error("코스피·ETF 종목 목록을 가져오지 못했습니다.");
    state.universe = { date: slot.date, stocks };
  }
  const universe = state.universe.stocks;
  const symbols = [...new Set([...universe.map(stock => stock.symbol), ...state.positions.map(p => p.symbol),
    ...(state.paperOrders ?? []).filter(o => ["PENDING", "PARTIAL_FILLED"].includes(o.status)).map(o => o.symbol), "069500"])];
  const morningCutoff = Date.parse(slot.date + "T09:00:00+09:00");
  const priorNews = slot.hour === 9 ? state.scans.findLast(item => item.news?.until === morningCutoff
    && item.news.sources?.length >= 2)?.news : null;
  const [quotes, rankings, indicators, indexCandles, currency, flows, news] = await Promise.all([
    loadPrices(client, symbols),
    client.get("rankings", { type: "MARKET_TRADING_AMOUNT", marketCountry: "KR", duration: "realtime", count: 100 }, true),
    client.get("market-indicators/prices", { symbols: "KOSPI,KOSDAQ" }, true),
    client.get("market-indicators/KOSPI/candles", { interval: "1d", count: 3 }, true),
    client.get("exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" }, true),
    client.get("market-indicators/KOSPI/investor-trading", { interval: "1d", count: 1 }, true),
    slot.hour === 9 && phase === "trade" ? priorNews ?? collectOpeningNews(day, slot) : null,
  ]);
  if (quotes.size === 0) throw new Error("토스증권에서 유효한 현재가를 받지 못했습니다.");
  const regular = day.today.integrated.regularMarket;
  const regularStart = Date.parse(regular.startTime);
  const regularEnd = Date.parse(regular.singlePriceAuctionStartTime ?? regular.endTime);
  const ranked = new Map(nearby(Date.parse(rankings?.rankedAt), Date.now(), 20 * 60_000)
    ? rankings.rankings.map(item => [item.symbol, item]) : []);
  const index = indicators?.find(item => item.symbol === "KOSPI");
  const benchmark = indexCandles?.candles?.find(item => item.timestamp.slice(0, 10) < slot.date);
  const indexChange = index && benchmark ? rate(Number(index.lastPrice), Number(benchmark.closePrice)) : null;
  const context = { ranked, indexChange, news };
  const flow = flows?.records?.[0];
  const net = flow?.foreigner ? Number(flow.foreigner.buyAmount) - Number(flow.foreigner.sellAmount) : null;
  const prior = state.previous?.date === slot.date && Number.isFinite(state.previous.time)
    && now - state.previous.time >= 0 && now - state.previous.time <= 13 * 60_000 ? state.previous.prices : null;
  const current = Date.now();
  const eligible = phase === "trade" ? shortlist(universe, quotes, prior, context, current, regularStart,
    new Set(state.positions.map(p => p.symbol)), Math.floor(account(state).total / 5)) : [];
  const candidates = [];
  for (const stock of eligible.slice(0, 7)) {
    if (client.requests >= 40) break;
    const candidate = await assess(client, stock, slot, regularStart, context);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= 5) break;
  }
  candidates.sort((a, b) => b.score - a.score);

  const books = new Map();
  if (phase === "trade") {
    const interested = [...new Set([...state.positions.map(p => p.symbol), ...candidates.map(c => c.symbol),
      ...(state.paperOrders ?? []).filter(o => ["PENDING", "PARTIAL_FILLED"].includes(o.status)).map(o => o.symbol)])];
    if (interested.length) {
      const fillQuotes = await loadPrices(client, interested);
      for (const symbol of interested) quotes.delete(symbol);
      for (const [symbol, quote] of fillQuotes) quotes.set(symbol, quote);
      if (state.paperModel?.enabled) for (const symbol of interested) books.set(symbol, await client.get("orderbook", { symbol }));
    }
  }

  const finish = Date.now();
  if (state.paperModel?.enabled) markPaper(state, "KR", quotes, null, finish);
  const baselineEquity = account(state).total;
  const trades = execute(state, { now: finish, regularStart, regularEnd, quotes, previous: prior, candidates,
    review: phase === "review", manual: slot.manual, books,
    openingExit: news ? (position, price) => openingExitReason(news, position, price, ranked.get(position.symbol)?.price?.basePrice) : null });
  const freshQuotes = [...quotes.entries()].filter(([, q]) => fresh(q, finish, regularStart));
  if (phase === "trade" && !slot.manual) {
    state.previous = { date: slot.date, hour: slot.hour, time: now,
      prices: Object.fromEntries(freshQuotes.map(([symbol, quote]) => [symbol, quote.price])) };
  }
  const totals = account(state);
  state.history.push({ time: finish, total: totals.total });
  state.latest = {
    at: finish, observed: universe.filter(stock => quotes.has(stock.symbol)).length,
    universe: universe.length, etfs: universe.filter(stock => stock.type === "ETF").length,
    fresh: freshQuotes.length, candidates: candidates.length,
    index: safeNumber(index?.lastPrice), indexChange, indexAt: Date.parse(index?.timestamp) || null,
    currency: safeNumber(currency?.midRate), currencyAt: Date.parse(currency?.validFrom) || null,
    foreignNet: Number.isFinite(net) ? net : null, flowDate: flow?.date ?? null, missing: [...client.missing],
  };
  if (state.paperModel?.enabled) recordAnalytics(state, "KR", finish, [
    ...(quotes.has("069500") ? [{ symbol: "069500", name: "KODEX 200", price: quotes.get("069500").price, time: quotes.get("069500").time, fx: 1 }] : []),
    ...(index ? [{ symbol: "KOSPI", name: "코스피", price: Number(index.lastPrice), time: Date.parse(index.timestamp), fx: 1 }] : []),
  ], baselineEquity);
  const message = phase === "review" ? "16시 모의 계좌 평가를 기록했습니다."
    : finish >= regularEnd ? "분석 중 연속매매 시간이 끝나 모의 주문을 건너뛰었습니다."
    : trades.length ? trades.length + "건의 모의 거래를 기록했습니다."
    : freshQuotes.length ? "시세를 분석했습니다. 체결 조건을 충족한 거래가 없었습니다."
    : "최신 체결가가 확인되지 않아 주문을 건너뛰었습니다.";
  return { status: phase === "review" ? "review" : "ok", message, trades, totals, news };
}

