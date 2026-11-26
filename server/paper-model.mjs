import { activateDailyPolicy } from "./strategy-policy.mjs";
export const MODEL_VERSION = "paper-v6-resting-limits";
export const defaults = market => ({ commissionBps: market === "US" ? 10 : 1.5, taxBps: market === "US" ? 0 : 20,
  fxSpreadBps: market === "US" ? 10 : 0, participationPct: 10, limitBps: 20, ttlSeconds: 300 });
export const activeOrder = order => ["PENDING", "PARTIAL_FILLED"].includes(order.status);
export function paperTotal(state, market) {
  const value = state.positions.reduce((sum, p) => sum + (market === "US" ? p.valueKrw : Math.floor(p.price * p.quantity)), 0);
  return state.cash + value;
}
export function upgradePaper(state, market, now) {
  const hadModel = Boolean(state.paperModel);
  state.paperOrders ??= []; state.alerts ??= []; state.versions ??= []; state.daily ??= [];
  state.costs ??= { commission: 0, transactionTax: 0, fxSpread: 0, slippage: 0 };
  state.liquidityUsage ??= {};
  state.operations ??= {};
  if (!state.paperModel || state.paperModel.code !== MODEL_VERSION) {
    const config = state.paperModel?.config ?? defaults(market);
    for (const order of state.paperOrders.filter(o => activeOrder(o) && o.side === "BUY")) { order.status = "CANCELED"; order.note = "전략 버전 변경: 다음 분석에서 새 규칙으로 평가"; }
    state.paperModel = { enabled: true, code: MODEL_VERSION, version: MODEL_VERSION + ":" + (state.versions.length + 1), config, appliedAt: now };
    state.versions.push({ id: state.paperModel.version, time: now, baseline: paperTotal(state, market),
      tradeCount: state.trades.length, config: { ...config }, rules: "10분 분석 · 5초 보유 감시 · 호가 잔량 10% · 5종목 · 종목별 비중 상한 없음 · 가용 현금 내 주문 · 장중 뉴스 2분/공시 1분 · 눌림 지정가/목표가 사전 주문 · −2.5%/+5%" });
  }
  activateDailyPolicy(state, market, now);
  if (state.monitorPolicy?.intervalMs !== 5000) {
    state.monitorPolicy = { intervalMs: 5000, appliedAt: now };
    if (hadModel) state.versions.push({ id: 'monitor-5s:' + (state.versions.length + 1), time: now, baseline: paperTotal(state, market),
      tradeCount: state.trades.length, config: { ...state.paperModel.config }, rules: '보유·기존 미체결 주문 감시 5초 · 신규 분석 10분 유지 · 오류 시 10~60초 대기 · 기존 주문·체결·설정 보존' });
  }
  return state;
}
export function setPaperConfig(state, market, now, changes) {
  const ranges = { commissionBps: [0, 100], taxBps: [0, 100], fxSpreadBps: [0, 200], participationPct: [1, 100], limitBps: [1, 100], ttlSeconds: [60, 900] };
  if (!changes || Object.keys(changes).length !== Object.keys(ranges).length) throw new Error("모의 체결 설정을 모두 입력해 주세요.");
  for (const [key, value] of Object.entries(changes)) if (!ranges[key] || typeof value !== "number" || !Number.isFinite(value)
    || value < ranges[key][0] || value > ranges[key][1]) throw new Error("모의 체결 설정 범위를 확인해 주세요.");
  upgradePaper(state, market, now);
  for (const order of state.paperOrders.filter(activeOrder)) { order.status = "CANCELED"; order.note = "체결 설정 변경"; }
  state.paperModel.config = { ...changes };
  state.paperModel.version = MODEL_VERSION + ":" + (state.versions.length + 1);
  state.versions.push({ id: state.paperModel.version, time: now, baseline: paperTotal(state, market), tradeCount: state.trades.length,
    config: { ...changes }, rules: "체결 비용·잔량 설정 변경, 이후 주문부터 적용" });
}
export function alertPaper(state, key, message, now, severity = "warning") {
  state.alerts ??= [];
  if (state.alerts.some(item => item.key === key && now - item.time < 3600_000)) return;
  state.alerts.push({ id: key + ":" + now, key, message, time: now, severity });
  state.alerts = state.alerts.slice(-100);
}
function money(native, quantity, fx, up = false) {
  const scaled = n => BigInt(Number(n).toFixed(8).replace(".", ""));
  const value = scaled(native) * BigInt(quantity) * scaled(fx), divisor = 10_000_000_000_000_000n;
  const result = Number((value + (up ? divisor - 1n : 0n)) / divisor);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("모의 체결 금액을 확인해야 합니다.");
  return result;
}
export function markPaper(state, market, quotes, fx, now) {
  for (const p of state.positions) {
    const q = quotes.get(p.symbol);
    if (q && q.time >= p.quoteTime && q.time <= now + 3000) { if (market === "US") p.priceUsd = q.price; else p.price = q.price; p.quoteTime = q.time; }
    if (market === "US" && fx) { p.price = p.priceUsd * fx.rate; p.fxRate = fx.rate; p.valueKrw = money(p.priceUsd, p.quantity, fx.rate); }
  }
}
function amounts(price, quantity, side, type, market, fx, config) {
  const gross = money(price, quantity, fx, side === "BUY");
  const commission = Math.ceil(gross * config.commissionBps / 10000);
  const transactionTax = side === "SELL" && type !== "ETF" ? Math.floor(gross * config.taxBps / 10000) : 0;
  const fxSpread = market === "US" ? Math.ceil(gross * config.fxSpreadBps / 10000) : 0;
  return { gross, commission, transactionTax, fxSpread, settlement: side === "BUY" ? gross + commission + fxSpread : gross - commission - transactionTax - fxSpread };
}
export function executePaper(state, { market, now, regularStart, regularEnd, quotes, books = new Map(), candidates = [], previous,
  review = false, manual = false, monitor = false, event = false, fx = null, reasonFor, openingExit }) {
  const config = state.paperModel.config;
  if (market === "KR") fx ??= { rate: 1, from: now, until: now + 60000 };
  if (!fx || !Number.isFinite(fx.rate) || !(fx.rate > 0) || !Number.isFinite(fx.from) || !Number.isFinite(fx.until)
    || fx.until <= now || fx.from > now + 3000 || fx.until <= fx.from) throw new Error("체결에 유효한 환율이 필요합니다.");
  if (market === "US") state.fx = fx;
  markPaper(state, market, quotes, fx, now);
  const fresh = q => q && q.time >= regularStart && q.time <= now + 3000 && now - q.time <= 90_000;
  for (const order of state.paperOrders.filter(activeOrder)) if (now >= order.expiresAt || now >= regularEnd) {
    order.status = "EXPIRED"; order.note = order.filledQuantity ? "잔량 유효시간 종료" : "미체결 유효시간 종료";
  }
  if (review || now < regularStart || now >= regularEnd) return [];
  const source = event ? "event" : monitor ? "monitor" : manual ? "manual" : "batch", trades = [], sold = new Set();
  const pending = (symbol, side) => state.paperOrders.some(o => activeOrder(o) && o.symbol === symbol && o.side === side);
  function newOrder(stock, side, quantity, quote, reason, plan = {}) {
    state.nextPaperOrder = (state.nextPaperOrder ?? 0) + 1;
    state.paperOrders.push({ id: "sim:" + market + ":" + state.nextPaperOrder, symbol: stock.symbol, name: stock.name, type: stock.type,
      side, quantity, filledQuantity: 0, status: "PENDING", reference: quote.price,
      limitPrice: plan.limitPrice ?? quote.price * (1 + (side === "BUY" ? 1 : -1) * config.limitBps / 10000),
      executionStyle: plan.style ?? "MARKETABLE_LIMIT",
      createdAt: now, expiresAt: Math.min(now + (plan.ttlSeconds ?? config.ttlSeconds) * 1000, regularEnd), reason, source: reason.startsWith("장중 ") ? "event" : source,
      strategyVersion: state.paperModel.version, config: { ...config }, note: "최신 호가와 잔량 확인 중" });
  }
  for (const o of state.paperOrders.filter(o => activeOrder(o) && o.side === "BUY")) {
    const q = quotes.get(o.symbol);
    if ((state.eventWatch?.blocks?.[o.symbol]?.until ?? 0) > now ||
      (o.executionStyle === "RESTING_ENTRY" && fresh(q) && (q.price < o.reference * .985 || q.price > o.reference * 1.01))) {
      o.status = "CANCELED"; o.note = "악재 또는 주문 기준가 이탈로 매수 잔량 취소";
    }
  }
  for (const p of [...state.positions]) {
    const q = quotes.get(p.symbol);
    if (!fresh(q)) continue;
    const reason = openingExit?.(p, q.price) ?? reasonFor({ ...p, entry: market === "US" ? p.entryUsd : p.entryPrice ?? p.entry }, q,
      previous?.[p.symbol], manual);
    const sells = state.paperOrders.filter(o => activeOrder(o) && o.symbol === p.symbol && o.side === "SELL");
    if (sells.some(o => o.executionStyle !== "RESTING_TAKE_PROFIT")) continue;
    if (reason && !reason.includes("익절")) {
      for (const o of sells) { o.status = "CANCELED"; o.note = "보호 매도 우선: " + reason; }
    } else if (sells.length) {
      const target = (market === "US" ? p.entryUsd : p.entryPrice ?? p.entry) * 1.05;
      if (sells.every(o => o.quantity - o.filledQuantity === p.quantity && Math.abs(o.limitPrice - target) < 1e-7)) continue;
      for (const o of sells) { o.status = "CANCELED"; o.note = "보유 수량·평균 매수가 변경으로 목표가 재설정"; }
    }
    if (reason) {
      for (const order of state.paperOrders.filter(o => activeOrder(o) && o.symbol === p.symbol && o.side === "BUY")) { order.status = "CANCELED"; order.note = "매도 신호 발생"; }
      newOrder(p, "SELL", p.quantity, q, reason);
    } else {
      const target = (market === "US" ? p.entryUsd : p.entryPrice ?? p.entry) * 1.05;
      if (Number.isFinite(target) && target > 0) newOrder(p, "SELL", p.quantity, q, "매수가 대비 +5% 목표가 사전 지정 주문", {
        style: "RESTING_TAKE_PROFIT", limitPrice: target, ttlSeconds: (regularEnd - now) / 1000 });
    }
  }
  if (!monitor) for (const c of candidates) {
    const occupied = new Set([...state.positions.map(p => p.symbol), ...state.paperOrders.filter(o => activeOrder(o) && o.side === "BUY").map(o => o.symbol)]);
    if (occupied.size >= 5 || occupied.has(c.symbol) || pending(c.symbol, "SELL") || (state.eventWatch?.blocks?.[c.symbol]?.until ?? 0) > now) continue;
    const q = quotes.get(c.symbol);
    if (!fresh(q) || !c.validPrice(q.price)) continue;
    const reserved = state.paperOrders.filter(o => activeOrder(o) && o.side === "BUY").reduce((sum, o) => sum + amounts(o.limitPrice, o.quantity - o.filledQuantity, "BUY", o.type, market, fx.rate, o.config).settlement, 0);
    const budget = Math.max(0, state.cash - reserved);
    const immediate = event || (Number.isFinite(c.momentum) && c.momentum >= 1 && !c.news?.caution);
    const limit = q.price * (1 + (immediate ? 1 : -1) * config.limitBps / 10000);
    if (!(limit > 0) || (!immediate && !c.validPrice(limit))) continue;
    let quantity = Math.floor(budget / (limit * fx.rate * (1 + (config.commissionBps + config.fxSpreadBps) / 10000)));
    while (quantity > 0 && amounts(limit, quantity, "BUY", c.type, market, fx.rate, config).settlement > budget) quantity--;
    if (quantity > 0) newOrder(c, "BUY", quantity, q, c.reason + (immediate ? " · 강한 상승세/뉴스 반응 즉시 체결 우선" : " · 눌림 가격 사전 지정 주문"), {
      style: immediate ? "MARKETABLE_LIMIT" : "RESTING_ENTRY", limitPrice: limit, ttlSeconds: immediate ? config.ttlSeconds : 900 });
  }
  const orders = state.paperOrders.filter(activeOrder).sort((a, b) => (a.side === "SELL" ? 0 : 1) - (b.side === "SELL" ? 0 : 1));
  for (const order of orders) {
    const q = quotes.get(order.symbol), book = books.get(order.symbol), time = Date.parse(book?.timestamp);
    if (!fresh(q) || book?.currency !== (market === "US" ? "USD" : "KRW") || !Number.isFinite(time) || time < regularStart || time > now + 3000 || now - time > 30_000) {
      order.note = "최신 체결가·호가가 없어 대기";
      alertPaper(state, "stale-book:" + order.symbol, order.name + "의 최신 호가가 없어 모의 체결을 보류했습니다.", now); continue;
    }
    const levels = (order.side === "BUY" ? book.asks : book.bids)?.filter(l => Number(l.price) > 0 && Number(l.volume) > 0)
      .map(l => ({ price: Number(l.price), volume: Math.floor(Number(l.volume)) })).sort((a, b) => order.side === "BUY" ? a.price - b.price : b.price - a.price).slice(0, 5) ?? [];
    const bestAsk = Math.min(...(book.asks ?? []).map(l => Number(l.price)).filter(p => p > 0));
    const bestBid = Math.max(...(book.bids ?? []).map(l => Number(l.price)).filter(p => p > 0));
    if (!(bestAsk >= bestBid && bestBid > 0)) { order.note = "비정상 호가로 대기"; continue; }
    for (const level of levels) {
      if (order.filledQuantity >= order.quantity) break;
      if (order.side === "BUY" ? level.price > order.limitPrice : level.price < order.limitPrice) continue;
      const key = order.symbol + ":" + order.side + ":" + time + ":" + level.price;
      const used = state.liquidityUsage[key]?.quantity ?? 0;
      let quantity = Math.min(order.quantity - order.filledQuantity, Math.max(0, Math.floor(level.volume * order.config.participationPct / 100) - used));
      let position = state.positions.find(p => p.symbol === order.symbol);
      if (order.side === "SELL") quantity = Math.min(quantity, position?.quantity ?? 0);
      if (order.side === "BUY" && sold.has(order.symbol)) continue;
      let costs = amounts(level.price, quantity, order.side, order.type, market, fx.rate, order.config);
      const otherReserved = order.side === "BUY" ? state.paperOrders.filter(o => o !== order && activeOrder(o) && o.side === "BUY").reduce((sum, o) => sum + amounts(o.limitPrice, o.quantity - o.filledQuantity, "BUY", o.type, market, fx.rate, o.config).settlement, 0) : 0;
      while (quantity > 0 && order.side === "BUY" && costs.settlement > Math.max(0, state.cash - otherReserved)) costs = amounts(level.price, --quantity, order.side, order.type, market, fx.rate, order.config);
      if (quantity < 1) continue;
      let realized = 0, priceEffectKrw = 0, fxEffectKrw = 0;
      if (order.side === "BUY") {
        if (!position) {
          position = { symbol: order.symbol, name: order.name, type: order.type, quantity: 0, costKrw: 0, nativeCost: 0, entryGrossKrw: 0,
            entryTime: now, ...(market === "US" ? { marketCountry: "US" } : {}) };
          state.positions.push(position);
        }
        position.costKrw ??= position.entry * position.quantity;
        position.nativeCost ??= (position.entryUsd ?? position.entryPrice ?? position.entry) * position.quantity;
        position.entryGrossKrw ??= position.costKrw;
        position.quantity += quantity; position.costKrw += costs.settlement;
        position.nativeCost += level.price * quantity; position.entryGrossKrw += costs.gross;
        position.entry = position.costKrw / position.quantity;
        position.entryPrice = position.nativeCost / position.quantity;
        if (market === "US") { position.entryUsd = position.entryPrice; position.entryFx = position.entryGrossKrw / position.nativeCost; }
        state.cash -= costs.settlement;
      } else {
        const before = position.quantity, ratio = quantity / before;
        const basis = quantity === before ? (position.costKrw ?? position.entry * before) : Math.round((position.costKrw ?? position.entry * before) * ratio);
        const native = (position.nativeCost ?? (position.entryUsd ?? position.entryPrice ?? position.entry) * before) * ratio;
        const entryFx = position.entryFx ?? (market === "US" ? position.costKrw / ((position.entryUsd ?? 1) * before) : 1);
        realized = costs.settlement - basis;
        priceEffectKrw = Math.round((level.price * quantity - native) * entryFx);
        fxEffectKrw = market === "US" ? Math.round(level.price * quantity * (fx.rate - entryFx)) : 0;
        state.cash += costs.settlement;
        if (market === "US") state.realized = (state.realized ?? 0) + realized;
        position.quantity -= quantity; position.costKrw = (position.costKrw ?? position.entry * before) - basis;
        position.nativeCost = (position.nativeCost ?? native / ratio) - native;
        position.entryGrossKrw = Math.max(0, (position.entryGrossKrw ?? basis) * (1 - ratio));
        if (!position.quantity) state.positions = state.positions.filter(p => p !== position);
        sold.add(order.symbol);
      }
      if (position.quantity) {
        position.quoteTime = q.time;
        if (market === "US") { position.priceUsd = q.price; position.price = q.price * fx.rate; position.fxRate = fx.rate; position.valueKrw = money(q.price, position.quantity, fx.rate); }
        else position.price = q.price;
      }
      const slippage = Math.round((level.price - order.reference) * quantity * fx.rate * (order.side === "BUY" ? 1 : -1));
      state.costs.commission += costs.commission; state.costs.transactionTax += costs.transactionTax;
      state.costs.fxSpread += costs.fxSpread; state.costs.slippage += slippage;
      order.filledQuantity += quantity;
      state.liquidityUsage[key] = { quantity: used + quantity, time };
      const total = paperTotal(state, market);
      const trade = { id: String(state.trades.length + 1), market, time: now, quoteTime: q.time, orderId: order.id,
        strategyVersion: order.strategyVersion, source: order.source === "event" ? "event" : source, symbol: order.symbol, name: order.name, type: order.type, side: order.side,
        quantity, price: level.price * fx.rate, amount: costs.gross, cashAmount: costs.settlement, costs: { commission: costs.commission, transactionTax: costs.transactionTax, fxSpread: costs.fxSpread, slippage },
        executionStyle: order.executionStyle ?? "MARKETABLE_LIMIT", limitPrice: order.limitPrice,
        reason: order.reason, realized, total, totalPnl: total - 10_000_000, priceEffectKrw, fxEffectKrw,
        costEffectKrw: order.side === "SELL" ? realized - priceEffectKrw - fxEffectKrw : 0,
        ...(market === "US" ? { currency: "USD", priceUsd: level.price, amountUsd: level.price * quantity, fxRate: fx.rate, fxTime: fx.from } : {}) };
      state.trades.push(trade); trades.push(trade);
    }
    order.status = order.filledQuantity >= order.quantity ? "FILLED" : order.filledQuantity ? "PARTIAL_FILLED" : "PENDING";
    order.note = order.status === "FILLED" ? "모의 전량 체결" : "허용 가격·호가 잔량 내에서만 체결, 나머지 대기";
    order.updatedAt = now;
  }
  for (const [key, value] of Object.entries(state.liquidityUsage)) if (now - value.time > 600_000) delete state.liquidityUsage[key];
  return trades;
}
