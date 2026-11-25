import { createHash } from "node:crypto";

// Deliberately disconnected from main.mjs, toss.mjs, the batch and the build.
// No environment variable, browser request or existing API key activates this code.
export const LIVE_TRADING_DEFAULTS = Object.freeze({ enabled: false });
const ORIGIN = "https://openapi.tossinvest.com";
const idPattern = /^[a-zA-Z0-9_-]{1,36}$/;
const orderIdPattern = /^[a-zA-Z0-9_-]{1,200}$/;
const symbolPattern = /^[A-Z0-9]{6}$/;
const isClientId = value => typeof value === "string" && idPattern.test(value);
const isOrderId = value => typeof value === "string" && orderIdPattern.test(value);
const isSymbol = value => typeof value === "string" && symbolPattern.test(value);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const integer = value => Number.isSafeInteger(value) && value > 0;
const dayAt = time => new Date(time + 9 * 3600_000).toISOString().slice(0, 10);

export class LiveTradingError extends Error {
  constructor(code, message, { status = null, requestId = null } = {}) {
    super(message);
    this.name = "LiveTradingError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}
function fail(code, message) { throw new LiveTradingError(code, message); }
function decimal(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,8})?$/.test(value) || value.length > 30) {
    fail("INVALID_BROKER_RESPONSE", "증권사 금액·수량 응답을 확인해야 합니다.");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}
function orderSnapshot(order, expectedId) {
  if (!order || !isOrderId(order.orderId) || (expectedId && order.orderId !== expectedId)
    || typeof order.status !== "string" || !order.execution) {
    fail("INVALID_BROKER_RESPONSE", "증권사 주문 상세 응답을 확인해야 합니다.");
  }
  const filled = decimal(order.execution.filledQuantity);
  return {
    orderId: order.orderId, status: order.status,
    fullyFilled: order.status === "FILLED", hasFills: filled > 0n,
    execution: Object.fromEntries(["filledQuantity", "averageFilledPrice", "filledAmount", "commission", "tax", "filledAt", "settlementDate"]
      .map(key => [key, order.execution[key] ?? null])),
  };
}

export function createLiveTrading({
  policy = LIVE_TRADING_DEFAULTS, tokenProvider, store, fetchImpl = globalThis.fetch, clock = Date.now,
  isStopped = () => false,
} = {}) {
  // Copy the authorization so a later mutation of the caller's object cannot arm this instance.
  const approval = { ...policy, symbols: Array.isArray(policy.symbols) ? [...policy.symbols] : [] };
  let stopped = false;
  let queue = Promise.resolve();
  function gate() {
    if (approval.enabled !== true || approval.userApproved !== true) {
      fail("LIVE_DISABLED", "실거래는 비활성 상태입니다. 사용자의 별도 적용 요청이 필요합니다.");
    }
    if (stopped || isStopped() !== false) fail("LIVE_STOPPED", "실거래 긴급 정지 상태입니다.");
    if (!integer(approval.accountSeq) || !Number.isFinite(Date.parse(approval.approvedAt))
      || Date.parse(approval.approvedAt) > clock()
      || !integer(approval.maxOrderKrw) || approval.maxOrderKrw >= 100_000_000
      || !integer(approval.maxDailyKrw) || approval.maxDailyKrw < approval.maxOrderKrw
      || !approval.symbols.length || approval.symbols.some(symbol => !isSymbol(symbol))
      || typeof tokenProvider !== "function" || !store) {
      fail("LIVE_NOT_CONFIGURED", "승인 계좌·허용 종목·주문 한도·원장 설정을 확인해야 합니다.");
    }
  }
  const account = String(approval.accountSeq);
  const serial = action => {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  };
  async function request(path, { method = "GET", body, accountScoped = true, params = {}, beforeSend = () => {} } = {}) {
    gate();
    let token;
    try { token = await tokenProvider(); } catch { fail("TOKEN_UNAVAILABLE", "실거래 토큰을 읽지 못했습니다."); }
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) fail("TOKEN_UNAVAILABLE", "실거래 토큰이 없습니다.");
    // Recheck after awaits: stopping during token loading must prevent a network write.
    gate();
    beforeSend();
    const url = new URL("/api/v1/" + path, ORIGIN);
    url.search = new URLSearchParams(params).toString();
    let response;
    let data;
    try {
      response = await fetchImpl(url, {
        method, redirect: "error", signal: AbortSignal.timeout(6500),
        headers: { authorization: "Bearer " + token,
          ...(accountScoped ? { "X-Tossinvest-Account": account } : {}),
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      data = await response.json();
    } catch {
      fail("BROKER_UNAVAILABLE", "증권사 응답을 확인하지 못했습니다. 주문을 자동 재전송하지 않습니다.");
    }
    if (!response.ok) {
      // Never expose a raw upstream message, token or account number in logs/errors.
      const code = /^[a-z0-9-]{1,80}$/.test(data?.error?.code) ? data.error.code : "BROKER_REJECTED";
      const requestId = /^[a-zA-Z0-9_-]{1,100}$/.test(data?.error?.requestId) ? data.error.requestId : null;
      throw new LiveTradingError(code, "증권사가 요청을 거절했습니다. 주문 상태를 확인해야 합니다.", { status: response.status, requestId });
    }
    if (!data || !Object.hasOwn(data, "result") || data.result == null) {
      fail("INVALID_BROKER_RESPONSE", "증권사 응답을 확인해야 합니다.");
    }
    return data.result;
  }
  function normalize(input) {
    if (!input || Object.keys(input).some(key => !["clientOrderId", "symbol", "side", "quantity", "price"].includes(key))
      || !isClientId(input.clientOrderId) || !isSymbol(input.symbol)
      || !approval.symbols.includes(input.symbol) || !["BUY", "SELL"].includes(input.side)
      || !integer(input.quantity) || !integer(input.price) || !Number.isSafeInteger(input.quantity * input.price)) {
      fail("INVALID_ORDER", "허용된 국내 종목의 지정가·정수 수량 주문만 지원합니다.");
    }
    if (input.quantity * input.price > approval.maxOrderKrw) fail("ORDER_LIMIT", "건당 주문 한도를 초과했습니다.");
    return { clientOrderId: input.clientOrderId, symbol: input.symbol, side: input.side,
      orderType: "LIMIT", timeInForce: "DAY", quantity: String(input.quantity), price: String(input.price) };
  }
  function reserve(clientId, action, payload, amount) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ action, payload })).digest("hex");
    let result;
    try {
      result = store.reserve({ account, clientId, action, fingerprint, payload,
        day: dayAt(clock()), amount, now: clock(), dailyLimit: approval.maxDailyKrw });
    } catch (error) {
      const known = ["UNRESOLVED_ORDER", "CANCEL_ALREADY_REQUESTED", "DAILY_LIMIT"];
      throw new LiveTradingError(known.includes(error.message) ? error.message : "LEDGER_UNAVAILABLE", "실거래 원장 확인이 필요하여 전송을 중단했습니다.");
    }
    if (result.existing && result.existing.fingerprint !== fingerprint) {
      fail("IDEMPOTENCY_CONFLICT", "같은 요청 ID에 다른 주문을 사용할 수 없습니다.");
    }
    return result.existing;
  }
  const update = (clientId, state, result = null, errorCode = null) => store.update(account, clientId,
    { state, result, errorCode, now: clock() });
  async function duringRegularMarket(symbol) {
    const date = dayAt(clock());
    const [accounts, calendar, warnings] = await Promise.all([
      request("accounts", { accountScoped: false }),
      request("market-calendar/KR", { accountScoped: false, params: { date } }),
      request("stocks/" + symbol + "/warnings", { accountScoped: false }),
    ]);
    if (!Array.isArray(accounts) || !accounts.some(row => String(row.accountSeq) === account && row.accountType === "BROKERAGE")) {
      fail("ACCOUNT_MISMATCH", "승인된 종합매매 계좌가 확인되지 않았습니다.");
    }
    const regular = calendar?.today?.integrated?.regularMarket;
    const start = Date.parse(regular?.startTime);
    // An unavailable auction boundary fails closed instead of allowing a closing-auction order.
    const end = Date.parse(regular?.singlePriceAuctionStartTime);
    const open = () => dayAt(clock()) === date && calendar?.today?.date === date
      && Number.isFinite(start) && Number.isFinite(end) && clock() >= start && clock() < end;
    if (!open()) fail("MARKET_CLOSED", "국내 정규장 연속매매 시간이 아닙니다.");
    if (!Array.isArray(warnings) || warnings.length) fail("STOCK_WARNING", "투자 경고 또는 종목 상태 확인이 필요합니다.");
    return open;
  }
  async function preflight(order) {
    const stillOpen = await duringRegularMarket(order.symbol);
    if (order.side === "BUY") {
      const [power, commissions] = await Promise.all([
        request("buying-power", { params: { currency: "KRW" } }), request("commissions"),
      ]);
      const today = dayAt(clock());
      const rows = Array.isArray(commissions) ? commissions.filter(row => row.marketCountry === "KR"
        && (row.startDate == null || row.startDate <= today) && (row.endDate == null || row.endDate >= today)) : [];
      if (power?.currency !== "KRW" || rows.length !== 1) fail("INVALID_BROKER_RESPONSE", "매수 가능 금액과 수수료를 확인해야 합니다.");
      const amount = BigInt(order.price) * BigInt(order.quantity);
      const commissionRate = decimal(rows[0].commissionRate);
      if (commissionRate > 100_000_000n) fail("INVALID_BROKER_RESPONSE", "수수료율 응답을 확인해야 합니다.");
      const fee = (amount * commissionRate + 99_999_999n) / 100_000_000n;
      if (decimal(power.cashBuyingPower) < (amount + fee) * 100_000_000n) fail("INSUFFICIENT_CASH", "수수료를 포함한 현금이 부족합니다.");
    } else {
      const available = await request("sellable-quantity", { params: { symbol: order.symbol } });
      if (decimal(available?.sellableQuantity) < BigInt(order.quantity) * 100_000_000n) fail("INSUFFICIENT_SHARES", "판매 가능 수량이 부족합니다.");
    }
    gate();
    if (!stillOpen()) fail("MARKET_CLOSED", "확인 중 정규장 연속매매 시간이 끝났습니다.");
    return () => {
      if (!stillOpen()) fail("MARKET_CLOSED", "전송 전에 정규장 연속매매 시간이 끝났습니다.");
    };
  }
  return {
    status() { return { enabled: approval.enabled === true && approval.userApproved === true, stopped }; },
    stop() { stopped = true; }, // One-way per instance. Re-arming requires new explicit authorization.
    submit(input) {
      return serial(async () => {
        gate();
        const order = normalize(input);
        const existing = reserve(order.clientOrderId, "CREATE", order, Number(order.quantity) * Number(order.price));
        if (existing) return existing; // Permanent local dedup; broker keys expire after ten minutes.
        let checkSession;
        try { checkSession = await preflight(order); } catch (error) {
          update(order.clientOrderId, "PRECHECK_FAILED", null, error.code ?? "PRECHECK_FAILED");
          throw error;
        }
        // Durable write BEFORE the POST: an interrupted process cannot silently retry it.
        update(order.clientOrderId, "SUBMITTING");
        try {
          const result = await request("orders", { method: "POST", body: order, beforeSend: checkSession });
          if (!isOrderId(result?.orderId)) fail("INVALID_BROKER_RESPONSE", "주문 접수 번호를 확인해야 합니다.");
          return update(order.clientOrderId, "ACKNOWLEDGED", { orderId: result.orderId, fullyFilled: false });
        } catch (error) {
          update(order.clientOrderId, "UNKNOWN", null, error.code ?? "ORDER_UNKNOWN");
          throw error;
        }
      });
    },
    refresh(clientOrderId) {
      return serial(async () => {
        gate();
        const row = store.get(account, clientOrderId);
        if (!row?.result?.orderId) fail("RECONCILIATION_REQUIRED", "접수 번호가 없는 주문은 증권사 내역을 직접 확인해야 합니다.");
        const detail = await request("orders/" + encodeURIComponent(row.result.orderId));
        const snapshot = orderSnapshot(detail, row.result.orderId);
        return update(clientOrderId, "ACKNOWLEDGED", snapshot);
      });
    },
    cancel({ clientOrderId, originalClientOrderId } = {}) {
      return serial(async () => {
        gate();
        if (!isClientId(clientOrderId) || !isClientId(originalClientOrderId)) fail("INVALID_ORDER", "취소 요청 ID를 확인해야 합니다.");
        const original = store.get(account, originalClientOrderId);
        if (original?.action !== "CREATE" || !original.result?.orderId) fail("ORDER_NOT_TRACKED", "이 원장에서 접수 번호가 확인된 주문만 취소할 수 있습니다.");
        const payload = { originalOrderId: original.result.orderId };
        const existing = reserve(clientOrderId, "CANCEL", payload, 0);
        if (existing) return existing;
        try {
          const detail = await request("orders/" + encodeURIComponent(payload.originalOrderId));
          const snapshot = orderSnapshot(detail, payload.originalOrderId);
          if (!["PENDING", "PARTIAL_FILLED"].includes(snapshot.status)) fail("NOT_CANCELABLE", "취소 가능한 미체결 주문 상태가 아닙니다.");
        } catch (error) {
          update(clientOrderId, "PRECHECK_FAILED", null, error.code ?? "PRECHECK_FAILED");
          throw error;
        }
        update(clientOrderId, "SUBMITTING");
        try {
          const result = await request("orders/" + encodeURIComponent(payload.originalOrderId) + "/cancel", { method: "POST", body: {} });
          if (!isOrderId(result?.orderId)) fail("INVALID_BROKER_RESPONSE", "취소 접수 번호를 확인해야 합니다.");
          // Cancellation has a NEW broker ID; acknowledgement does not mean cancellation completed.
          return update(clientOrderId, "ACKNOWLEDGED", { orderId: result.orderId, originalOrderId: payload.originalOrderId, fullyFilled: false });
        } catch (error) {
          update(clientOrderId, "UNKNOWN", null, error.code ?? "CANCEL_UNKNOWN");
          throw error;
        }
      });
    },
    async holdings() { return request("holdings"); },
    async listOrders({ status = "OPEN", symbol, from, to, cursor, limit = 100 } = {}) {
      gate();
      if (!["OPEN", "CLOSED"].includes(status) || !integer(limit) || limit > 100
        || (symbol !== undefined && !isSymbol(symbol))
        || [from, to].some(value => value !== undefined && !datePattern.test(value))
        || (from && to && from > to) || (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 2000))) {
        fail("INVALID_QUERY", "주문 조회 조건을 확인해야 합니다.");
      }
      const params = { status, limit: String(limit) };
      for (const [key, value] of Object.entries({ symbol, from, to, cursor })) if (value !== undefined) params[key] = value;
      return request("orders", { params });
    },
  };
}
