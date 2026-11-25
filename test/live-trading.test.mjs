import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLiveTrading, LIVE_TRADING_DEFAULTS } from "../server/live/trading.mjs";
import { openLiveOrderStore } from "../server/live/store.mjs";

const at = time => Date.parse("2026-11-25T" + time + ":00+09:00");
const policy = () => ({ enabled: true, userApproved: true, approvedAt: "2026-11-25T09:00:00+09:00",
  accountSeq: 7, symbols: ["005930", "069500"], maxOrderKrw: 200_000, maxDailyKrw: 300_000 });
const order = (clientOrderId = "buy-one", changes = {}) => ({ clientOrderId, symbol: "005930", side: "BUY", quantity: 2, price: 70_000, ...changes });
const errorCode = code => error => error.code === code;
function fixture(t, options = {}) {
  const calls = [];
  const store = options.store ?? openLiveOrderStore(":memory:");
  if (!options.store) t.after(() => store.close());
  let time = at("10:00");
  let state = "PENDING";
  let filledQuantity = "0";
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://openapi.tossinvest.com");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer fake-token-never-issued");
    const route = parsed.pathname.replace("/api/v1/", "");
    calls.push({ route, url: parsed, ...init });
    if (["accounts", "market-calendar/KR", "stocks/005930/warnings", "stocks/069500/warnings"].includes(route)) {
      assert.equal(init.headers["X-Tossinvest-Account"], undefined);
    } else assert.equal(init.headers["X-Tossinvest-Account"], "7");
    if (options.respond) {
      const response = await options.respond(route, init, calls);
      if (response !== undefined) return response;
    }
    const result = value => Response.json({ result: value });
    if (route === "accounts") return result([{ accountSeq: 7, accountType: "BROKERAGE" }]);
    if (route === "market-calendar/KR") return result({ today: { date: "2026-11-25", integrated: { regularMarket: {
      startTime: new Date(at("09:00")).toISOString(), singlePriceAuctionStartTime: new Date(at("15:20")).toISOString(),
    } } } });
    if (route.endsWith("/warnings")) return result([]);
    if (route === "buying-power") return result({ currency: "KRW", cashBuyingPower: "900000" });
    if (route === "commissions") return result([{ marketCountry: "KR", commissionRate: "0.00015", startDate: null, endDate: null }]);
    if (route === "sellable-quantity") return result({ sellableQuantity: "2" });
    if (route === "holdings") return result({ items: [] });
    if (route === "orders" && init.method === "POST") return result({ orderId: "broker-" + JSON.parse(init.body).clientOrderId });
    if (route.endsWith("/cancel")) return result({ orderId: "cancel-operation" });
    if (route.startsWith("orders/")) return result({ orderId: route.slice(7), status: state,
      execution: { filledQuantity, averageFilledPrice: filledQuantity === "0" ? null : "70000" } });
    if (route === "orders") return result({ orders: [], nextCursor: null, hasNext: false });
    throw new Error("Unexpected network request: " + route);
  };
  const service = createLiveTrading({ policy: options.policy ?? policy(), store, fetchImpl,
    tokenProvider: options.tokenProvider ?? (async () => "fake-token-never-issued"), clock: () => time,
    isStopped: options.isStopped ?? (() => false) });
  return { service, store, calls, setTime: value => { time = value; },
    setDetail: (status, filled) => { state = status; filledQuantity = filled; } };
}

test("disabled by default; keys or mutable caller settings cannot activate the backend", async () => {
  let calls = 0;
  const settings = { enabled: false };
  const disabled = createLiveTrading({ policy: settings, tokenProvider: async () => { calls++; return "unused"; },
    fetchImpl: async () => { calls++; throw new Error("Must not access the network"); } });
  settings.enabled = true;
  settings.userApproved = true;
  assert.equal(LIVE_TRADING_DEFAULTS.enabled, false);
  await assert.rejects(disabled.submit(order()), errorCode("LIVE_DISABLED"));
  await assert.rejects(disabled.cancel({ clientOrderId: "cancel", originalClientOrderId: "one" }), errorCode("LIVE_DISABLED"));
  await assert.rejects(disabled.refresh("one"), errorCode("LIVE_DISABLED"));
  await assert.rejects(disabled.holdings(), errorCode("LIVE_DISABLED"));
  await assert.rejects(disabled.listOrders(), errorCode("LIVE_DISABLED"));
  assert.equal(calls, 0);
});

test("explicit account, authorization, limits and a durable ledger are required", async t => {
  for (const changes of [{ userApproved: false }, { accountSeq: "7" }, { approvedAt: null },
    { symbols: [] }, { maxOrderKrw: 100_000_000 }, { maxDailyKrw: 0 }]) {
    const f = fixture(t, { policy: { ...policy(), ...changes } });
    await assert.rejects(f.service.submit(order()), errorCode(changes.userApproved === false ? "LIVE_DISABLED" : "LIVE_NOT_CONFIGURED"));
    assert.equal(f.calls.length, 0);
  }
});

test("only bounded KR integer LIMIT DAY orders are sent; acceptance is not a fill", async t => {
  const f = fixture(t);
  const accepted = await f.service.submit(order());
  assert.equal(accepted.state, "ACKNOWLEDGED");
  assert.equal(accepted.result.fullyFilled, false);
  const posts = f.calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { clientOrderId: "buy-one", symbol: "005930", side: "BUY",
    quantity: "2", price: "70000", orderType: "LIMIT", timeInForce: "DAY" });
  assert.equal(posts[0].signal.aborted, false);
  f.setDetail("PARTIAL_FILLED", "1");
  const partial = await f.service.refresh("buy-one");
  assert.equal(partial.result.hasFills, true);
  assert.equal(partial.result.fullyFilled, false);
  assert.equal(partial.result.execution.filledQuantity, "1");
  f.setDetail("FILLED", "2");
  assert.equal((await f.service.refresh("buy-one")).result.fullyFilled, true);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("rejects unsupported orders and unsafe amounts before any network access", async t => {
  const f = fixture(t);
  for (const changes of [{ quantity: 0 }, { quantity: 1.5 }, { price: Infinity }, { price: "70000" },
    { quantity: Number.MAX_SAFE_INTEGER }, { symbol: "AAPL" }, { symbol: "000660" },
    { orderType: "MARKET" }, { confirmHighValueOrder: true }, { clientOrderId: 123 }, { side: "buy" }]) {
    await assert.rejects(f.service.submit(order("invalid", changes)), errorCode("INVALID_ORDER"));
  }
  await assert.rejects(f.service.submit(order("large", { quantity: 3 })), errorCode("ORDER_LIMIT"));
  assert.equal(f.calls.length, 0);
});

test("holidays, unapproved accounts, warnings and insufficient cash including fees block POST", async t => {
  const cases = [
    ["MARKET_CLOSED", "market-calendar/KR", { today: { date: "2026-11-25", integrated: {} } }],
    ["ACCOUNT_MISMATCH", "accounts", [{ accountSeq: 8, accountType: "BROKERAGE" }]],
    ["STOCK_WARNING", "stocks/005930/warnings", [{ code: "WARNING" }]],
    ["INSUFFICIENT_CASH", "buying-power", { currency: "KRW", cashBuyingPower: "140000" }],
    ["INVALID_BROKER_RESPONSE", "commissions", []],
  ];
  for (const [code, path, result] of cases) {
    const f = fixture(t, { respond: route => route === path ? Response.json({ result }) : undefined });
    await assert.rejects(f.service.submit(order()), errorCode(code));
    assert.equal(f.store.get("7", "buy-one").state, "PRECHECK_FAILED");
    assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  }
});

test("sell orders check available shares and do not use the paper portfolio", async t => {
  const f = fixture(t, { respond: route => route === "sellable-quantity" ? Response.json({ result: { sellableQuantity: "1" } }) : undefined });
  await assert.rejects(f.service.submit(order("sell", { side: "SELL" })), errorCode("INSUFFICIENT_SHARES"));
  assert.equal(f.calls.some(call => call.method === "POST"), false);
  assert.equal(f.calls.some(call => call.route === "buying-power"), false);
  const good = fixture(t);
  assert.equal((await good.service.submit(order("sell-good", { side: "SELL" }))).state, "ACKNOWLEDGED");
});

test("concurrent duplicate requests send one POST and conflicting reused IDs are rejected", async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.service.submit(order()), f.service.submit(order())]);
  assert.equal(a.result.orderId, b.result.orderId);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  await assert.rejects(f.service.submit(order("buy-one", { quantity: 1 })), errorCode("IDEMPOTENCY_CONFLICT"));
  await f.service.submit(order("buy-two"));
  await assert.rejects(f.service.submit(order("buy-three", { quantity: 1 })), errorCode("DAILY_LIMIT"));
  assert.equal(f.calls.filter(call => call.method === "POST").length, 2);
});

test("permanent dedup and uncertain submission guards survive database reopen and a new day", async t => {
  const directory = mkdtempSync(join(tmpdir(), "marketlab-live-"));
  const path = join(directory, "orders.sqlite");
  let store = openLiveOrderStore(path);
  t.after(() => { store.close(); unlinkSync(path); rmdirSync(directory); });
  const first = fixture(t, { store });
  await first.service.submit(order());
  store.close();
  store = openLiveOrderStore(path);
  const restarted = fixture(t, { store });
  restarted.setTime(Date.parse("2026-11-26T10:00:00+09:00"));
  assert.equal((await restarted.service.submit(order())).result.orderId, "broker-buy-one");
  assert.equal(restarted.calls.length, 0);
  // An interrupted process may have sent a POST. Never infer that retrying is safe.
  store.reserve({ account: "7", clientId: "crash", action: "CREATE", fingerprint: "crashed",
    payload: {}, day: "2026-11-25", amount: 1000, dailyLimit: 300000, now: at("10:00") });
  await assert.rejects(restarted.service.submit(order("after-crash")), errorCode("UNRESOLVED_ORDER"));
  assert.equal(restarted.calls.length, 0);
});

test("timeouts, malformed acknowledgements and rate limiting never automatically resend an order", async t => {
  for (const behavior of ["timeout", "malformed", "rate-limit"]) {
    const f = fixture(t, { respond: (route, init) => {
      if (route !== "orders" || init.method !== "POST") return;
      if (behavior === "timeout") throw new Error("secret-token-must-not-leak");
      if (behavior === "malformed") return Response.json({ result: {} });
      return Response.json({ error: { code: "rate-limit-exceeded", message: "secret-token-must-not-leak" } }, { status: 429 });
    } });
    await assert.rejects(f.service.submit(order()), error => !error.message.includes("secret-token"));
    assert.equal(f.store.get("7", "buy-one").state, "UNKNOWN");
    const oldCalls = f.calls.length;
    assert.equal((await f.service.submit(order())).state, "UNKNOWN");
    await assert.rejects(f.service.submit(order("new-id")), errorCode("UNRESOLVED_ORDER"));
    assert.equal(f.calls.length, oldCalls);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("stop is checked again after token loading and cannot be reversed on this instance", async t => {
  let tokenLoads = 0;
  let stopped = false;
  const f = fixture(t, { isStopped: () => stopped, tokenProvider: async () => {
    tokenLoads++;
    if (tokenLoads === 6) stopped = true; // All preflight GETs completed; token load for POST.
    return "fake-token-never-issued";
  } });
  await assert.rejects(f.service.submit(order()), errorCode("LIVE_STOPPED"));
  assert.equal(f.calls.some(call => call.method === "POST"), false);
  const g = fixture(t);
  g.service.stop();
  await assert.rejects(g.service.submit(order()), errorCode("LIVE_STOPPED"));
  assert.equal(g.calls.length, 0);
});

test("market close during the final token await prevents order transmission", async t => {
  let tokenLoads = 0;
  const f = fixture(t, { tokenProvider: async () => {
    if (++tokenLoads === 6) f.setTime(at("15:20"));
    return "fake-token-never-issued";
  } });
  await assert.rejects(f.service.submit(order()), errorCode("MARKET_CLOSED"));
  assert.equal(f.calls.some(call => call.method === "POST"), false);
});

test("cancellation retains the original ID, stores its new operation ID and is not a completed cancel", async t => {
  const f = fixture(t);
  await f.service.submit(order());
  f.setDetail("PARTIAL_FILLED", "1");
  const cancel = await f.service.cancel({ clientOrderId: "cancel-one", originalClientOrderId: "buy-one" });
  assert.equal(cancel.result.orderId, "cancel-operation");
  assert.equal(cancel.result.originalOrderId, "broker-buy-one");
  assert.equal(cancel.result.fullyFilled, false);
  assert.equal(f.store.get("7", "buy-one").result.orderId, "broker-buy-one");
  await f.service.cancel({ clientOrderId: "cancel-one", originalClientOrderId: "buy-one" });
  await assert.rejects(f.service.cancel({ clientOrderId: "cancel-two", originalClientOrderId: "buy-one" }), errorCode("CANCEL_ALREADY_REQUESTED"));
  assert.equal(f.calls.filter(call => call.route.endsWith("/cancel")).length, 1);
  f.setDetail("CANCELED", "1");
  const detail = await f.service.refresh("cancel-one");
  assert.equal(detail.result.status, "CANCELED");
  assert.equal(detail.result.hasFills, true);
  assert.equal(detail.result.fullyFilled, false);
});

test("cancel failures remain uncertain; filled and untracked orders cannot be cancelled", async t => {
  const f = fixture(t, { respond: route => { if (route.endsWith("/cancel")) throw new Error("lost response"); } });
  await f.service.submit(order());
  await assert.rejects(f.service.cancel({ clientOrderId: "cancel-one", originalClientOrderId: "buy-one" }), errorCode("BROKER_UNAVAILABLE"));
  assert.equal(f.store.get("7", "cancel-one").state, "UNKNOWN");
  await f.service.cancel({ clientOrderId: "cancel-one", originalClientOrderId: "buy-one" });
  assert.equal(f.calls.filter(call => call.route.endsWith("/cancel")).length, 1);
  const g = fixture(t);
  await assert.rejects(g.service.cancel({ clientOrderId: "cancel", originalClientOrderId: "not-known" }), errorCode("ORDER_NOT_TRACKED"));
  await g.service.submit(order());
  g.setDetail("FILLED", "2");
  await assert.rejects(g.service.cancel({ clientOrderId: "cancel", originalClientOrderId: "buy-one" }), errorCode("NOT_CANCELABLE"));
  assert.equal(g.calls.some(call => call.route.endsWith("/cancel")), false);
});

test("read-only order pagination is explicit and uses the approved account", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.holdings(), { items: [] });
  const listed = await f.service.listOrders({ status: "CLOSED", from: "2026-11-01", to: "2026-11-25", cursor: "next-page", limit: 20 });
  assert.equal(listed.hasNext, false);
  const call = f.calls.at(-1);
  assert.equal(call.url.searchParams.get("status"), "CLOSED");
  assert.equal(call.url.searchParams.get("cursor"), "next-page");
  assert.equal(call.url.searchParams.get("limit"), "20");
  await assert.rejects(f.service.listOrders({ status: "FILLED" }), errorCode("INVALID_QUERY"));
  assert.equal(f.calls.some(call => call.method === "POST"), false);
});
