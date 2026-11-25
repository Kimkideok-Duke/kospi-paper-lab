export const INITIAL = 10_000_000;
export const LIMIT = 5;
export const START = "2026-11-25";
export const END = "2026-12-25";
export const WON = new Intl.NumberFormat("ko-KR");

export function kst(now) {
  return new Date(now + 9 * 3600_000).toISOString();
}

export function slotFor(now) {
  const local = kst(now);
  const date = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  const minute = Number(local.slice(14, 16));
  if (date < START || date >= END || hour < 9 || hour > 16 || minute >= 15) return null;
  if ([0, 6].includes(new Date(date).getUTCDay())) return null;
  return { date, hour, id: local.slice(0, 13), review: hour === 16 };
}

export function initialState() {
  return {
    cash: INITIAL, positions: [], trades: [], history: [], scans: [],
    latest: null, lastError: null, universe: null, calendar: null, previous: null,
  };
}

export function account(state) {
  const marketValue = state.positions.reduce((sum, p) => sum + p.price * p.quantity, 0);
  const cost = state.positions.reduce((sum, p) => sum + p.entry * p.quantity, 0);
  const total = state.cash + marketValue;
  return { cash: state.cash, marketValue, total, pnl: total - INITIAL, openPnl: marketValue - cost,
    realized: total - INITIAL - (marketValue - cost) };
}

export function marketPhase(calendar, time, slot) {
  const day = calendar?.today;
  if (day?.date !== slot.date) return "closed";
  const regular = day.integrated?.regularMarket;
  if (!regular) return "closed";
  if (slot.review) return "review";
  const start = Date.parse(regular.startTime);
  const end = Date.parse(regular.singlePriceAuctionStartTime ?? regular.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "closed";
  return time >= start && time < end ? "trade" : "closed";
}

export const rate = (value, reference) => reference > 0 ? 100 * (value / reference - 1) : null;
export const weight = (value, min, max) => Math.max(min, Math.min(max, value));
export const percentage = value => (value > 0 ? "+" : "") + value.toFixed(2) + "%";

export function quoteMap(rows) {
  if (!Array.isArray(rows)) throw new Error("토스증권 현재가 응답을 읽을 수 없습니다.");
  return new Map(rows.filter(row => row.currency === "KRW" && Number.isSafeInteger(Number(row.lastPrice))
    && Number(row.lastPrice) > 0 && Number.isFinite(Date.parse(row.timestamp)))
    .map(row => [row.symbol, { price: Number(row.lastPrice), time: Date.parse(row.timestamp) }]));
}

export function fresh(quote, now, regularStart) {
  return quote && quote.time >= regularStart && quote.time <= now + 3000 && now - quote.time <= 90_000;
}

export function mark(state, quotes, time) {
  for (const position of state.positions) {
    const quote = quotes.get(position.symbol);
    if (quote && quote.time >= position.quoteTime && quote.time <= time + 3000) {
      position.price = quote.price;
      position.quoteTime = quote.time;
    }
  }
}

export function sellReason(position, quote, previousPrice) {
  const change = rate(quote.price, position.entry);
  const intraday = rate(quote.price, previousPrice);
  if (change <= -2.5) return "매수가 대비 " + percentage(change) + " 하락으로 손절 기준(−2.5%) 도달";
  if (change >= 5) return "매수가 대비 " + percentage(change) + " 상승으로 익절 기준(+5%) 도달";
  if (intraday !== null && intraday <= -1.5) return "직전 시간 대비 " + percentage(intraday) + "로 단기 추세 약화";
  return null;
}

function tradeRow(state, position, side, quote, reason, time, realized) {
  const totals = account(state);
  return {
    id: String(state.trades.length + 1), time, quoteTime: quote.time, symbol: position.symbol,
    name: position.name, type: position.type, side, quantity: position.quantity, price: quote.price,
    amount: quote.price * position.quantity, reason, realized, total: totals.total, totalPnl: totals.pnl,
  };
}

export function execute(state, { now, regularStart, regularEnd, quotes, previous, candidates, review }) {
  mark(state, quotes, now);
  const trades = [];
  if (review || now < regularStart || now >= regularEnd) return trades;
  const sold = new Set();
  for (const position of [...state.positions]) {
    const quote = quotes.get(position.symbol);
    if (!fresh(quote, now, regularStart)) continue;
    const reason = sellReason(position, quote, previous?.[position.symbol]);
    if (!reason) continue;
    state.cash += position.quantity * quote.price;
    state.positions = state.positions.filter(item => item.symbol !== position.symbol);
    const trade = tradeRow(state, position, "SELL", quote, reason, now, (quote.price - position.entry) * position.quantity);
    state.trades.push(trade);
    trades.push(trade);
    sold.add(position.symbol);
  }
  for (const candidate of candidates) {
    if (state.positions.length >= LIMIT) break;
    if (sold.has(candidate.symbol) || state.positions.some(position => position.symbol === candidate.symbol)) continue;
    const quote = quotes.get(candidate.symbol);
    if (!fresh(quote, now, regularStart) || !candidate.validPrice(quote.price)) continue;
    const budget = Math.min(state.cash, Math.floor(account(state).total / LIMIT));
    const quantity = Math.floor(budget / quote.price);
    if (quantity < 1) continue;
    const position = { symbol: candidate.symbol, name: candidate.name, type: candidate.type,
      quantity, entry: quote.price, price: quote.price, quoteTime: quote.time };
    state.cash -= position.quantity * quote.price;
    state.positions.push(position);
    const trade = tradeRow(state, position, "BUY", quote, candidate.reason, now, 0);
    state.trades.push(trade);
    trades.push(trade);
  }
  return trades;
}
