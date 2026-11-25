import { INITIAL, LIMIT, START, END, fresh, sellReason } from "./engine.mjs";
import { executePaper } from "./paper-model.mjs";

export { INITIAL, LIMIT, START, END };
const eastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export function usDate(now) {
  const parts = Object.fromEntries(eastern.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function usLocalTime(date, time) {
  const target = Date.parse(date + "T" + time + ":00Z");
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let value = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(value).map(part => [part.type, part.value]));
    value += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return value;
}
export function usSlots(day) {
  if (!day || day.date < START || day.date >= END) return [];
  const start = Date.parse(day.regularMarket?.startTime);
  const end = Date.parse(day.regularMarket?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || usDate(start) !== day.date || usDate(end - 1) !== day.date) return [];
  const times = [start + 3 * 60_000];
  for (let time = start + 600_000; time < end; time += 600_000) times.push(time);
  return [...times.filter(time => time < end), end].map((time, index) => ({ market: "US", date: day.date,
    id: "us:" + new Date(time).toISOString(), time, regularStart: start, regularEnd: end,
    opening: index === 0, review: time === end, index }));
}
export function usSlotFor(calendar, now, requestId = null) {
  const slots = usSlots(calendar?.today);
  if (!slots.length || usDate(now) !== calendar.today.date) return null;
  if (requestId) {
    const first = slots[0];
    if (now < first.regularStart || now >= first.regularEnd) return null;
    return { ...first, id: "us:manual:" + requestId, time: now, manual: true, review: false,
      opening: now < first.regularStart + 600_000, index: Math.floor((now - first.regularStart) / 600_000) };
  }
  return slots.find(slot => now >= slot.time && now < Math.min(slot.time + 3 * 60_000, slot.review ? Infinity : slot.regularEnd)) ?? null;
}
export function nextUsSlot(calendar, now) {
  return [calendar?.today, calendar?.nextBusinessDay].flatMap(usSlots).find(slot => slot.time > now)?.time ?? null;
}
export function initialUsState() {
  return { cash: INITIAL, realized: 0, positions: [], trades: [], history: [], scans: [], latest: null,
    lastError: null, universe: null, calendar: null, previous: null, fx: null };
}
const scaled = value => {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e9) throw new Error("달러 가격 또는 환율을 확인해야 합니다.");
  return BigInt(Number(value).toFixed(8).replace(".", ""));
};
export function krwAmount(priceUsd, quantity, fxRate, roundUp = false) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("모의 주문 수량이 유효하지 않습니다.");
  const product = scaled(priceUsd) * BigInt(quantity) * scaled(fxRate);
  const divisor = 10_000_000_000_000_000n;
  const amount = Number((product + (roundUp ? divisor - 1n : 0n)) / divisor);
  if (!Number.isSafeInteger(amount)) throw new Error("모의 주문 금액을 확인해야 합니다.");
  return amount;
}
export function usAccount(state) {
  const marketValue = state.positions.reduce((sum, p) => sum + p.valueKrw, 0);
  const cost = state.positions.reduce((sum, p) => sum + p.costKrw, 0);
  const total = state.cash + marketValue;
  return { cash: state.cash, marketValue, total, pnl: total - INITIAL, openPnl: marketValue - cost, realized: state.realized };
}
export function usdQuoteMap(rows) {
  if (!Array.isArray(rows)) throw new Error("미국장 시세 응답을 읽지 못했습니다.");
  return new Map(rows.filter(row => row.currency === "USD" && Number(row.lastPrice) > 0 && Number(row.lastPrice) <= 1e9 && Number.isFinite(Date.parse(row.timestamp)))
    .map(row => [row.symbol, { price: Number(row.lastPrice), time: Date.parse(row.timestamp) }]));
}
export function validFx(row, now) {
  const from = Date.parse(row?.validFrom), until = Date.parse(row?.validUntil), rate = Number(row?.midRate);
  if (row?.baseCurrency !== "USD" || row?.quoteCurrency !== "KRW" || !(rate > 0 && rate <= 1e6)
    || !Number.isFinite(from) || !Number.isFinite(until) || from > now + 3000 || until <= now || until <= from) {
    throw new Error("유효한 USD/KRW 환율이 없어 미국장 모의 거래를 건너뜁니다.");
  }
  return { rate, from, until };
}
export function executeUs(state, { now, slot, quotes, fx, candidates = [], previous, openingExit, books, monitor, event }) {
  if (state.paperModel?.enabled) return executePaper(state, { market: "US", now, regularStart: slot.regularStart, regularEnd: slot.regularEnd,
    quotes, fx, candidates, previous, openingExit, books, review: slot.review, manual: slot.manual, monitor, event, reasonFor: sellReason });
  if (!fx || !Number.isFinite(fx.rate) || !(fx.rate > 0) || !Number.isFinite(fx.from) || !Number.isFinite(fx.until)
    || fx.from > now + 3000 || fx.until <= now || fx.until <= fx.from) throw new Error("미국장 모의 거래에 유효한 환율이 필요합니다.");
  state.fx = fx;
  for (const position of state.positions) {
    const quote = quotes.get(position.symbol);
    if (quote && quote.time >= position.quoteTime && quote.time <= now + 3000) {
      position.priceUsd = quote.price;
      position.quoteTime = quote.time;
    }
    position.price = position.priceUsd * fx.rate;
    position.fxRate = fx.rate;
    position.valueKrw = krwAmount(position.priceUsd, position.quantity, fx.rate);
  }
  if (slot.review || now < slot.regularStart || now >= slot.regularEnd || usDate(now) !== slot.date) return [];
  const trades = [], sold = new Set();
  function record(position, side, quote, amount, realized, reason) {
    const total = usAccount(state);
    const row = { id: String(state.trades.length + 1), market: "US", currency: "USD", time: now, quoteTime: quote.time,
      symbol: position.symbol, name: position.name, type: position.type, side, quantity: position.quantity,
      price: quote.price * fx.rate, priceUsd: quote.price, amountUsd: quote.price * position.quantity,
      fxRate: fx.rate, fxTime: fx.from, amount, reason, realized, total: total.total, totalPnl: total.pnl,
      source: slot.manual ? "manual" : "batch" };
    state.trades.push(row); trades.push(row);
  }
  for (const position of [...state.positions]) {
    const quote = quotes.get(position.symbol);
    if (!fresh(quote, now, slot.regularStart)) continue;
    const reason = sellReason({ entry: position.entryUsd }, quote, previous?.[position.symbol], slot.manual)
      ?? openingExit?.(position, quote.price);
    if (!reason) continue;
    const amount = krwAmount(quote.price, position.quantity, fx.rate);
    const realized = amount - position.costKrw;
    state.cash += amount; state.realized += realized;
    state.positions = state.positions.filter(p => p.symbol !== position.symbol);
    record(position, "SELL", quote, amount, realized, reason);
    sold.add(position.symbol);
  }
  for (const candidate of candidates) {
    if (state.positions.length >= LIMIT) break;
    if (sold.has(candidate.symbol) || state.positions.some(p => p.symbol === candidate.symbol)) continue;
    const quote = quotes.get(candidate.symbol);
    if (!fresh(quote, now, slot.regularStart) || !candidate.validPrice(quote.price)) continue;
    const budget = state.cash;
    let quantity = Math.floor(budget / (quote.price * fx.rate));
    while (quantity > 0 && krwAmount(quote.price, quantity, fx.rate, true) > budget) quantity--;
    if (quantity < 1) continue;
    const amount = krwAmount(quote.price, quantity, fx.rate, true);
    const position = { symbol: candidate.symbol, name: candidate.name, type: candidate.type, marketCountry: "US",
      quantity, entryUsd: quote.price, priceUsd: quote.price, entry: amount / quantity, price: quote.price * fx.rate,
      costKrw: amount, entryFx: fx.rate, fxRate: fx.rate, valueKrw: krwAmount(quote.price, quantity, fx.rate), quoteTime: quote.time };
    state.cash -= amount; state.positions.push(position);
    record(position, "BUY", quote, amount, 0, candidate.reason);
  }
  return trades;
}
