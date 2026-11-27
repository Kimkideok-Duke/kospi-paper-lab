import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { initialState, execute, account, sellReason, slotFor, slotTime } from "../server/engine.mjs";
import { initialUsState, executeUs, usAccount, usLocalTime } from "../server/us-engine.mjs";
import { upgradePaper, setPaperConfig, defaults } from "../server/paper-model.mjs";
import { analyticsView, recordAnalytics } from "../server/paper-analytics.mjs";
import { startMonitorBatch } from "../server/monitor-batch.mjs";
import "../scripts/build.mjs";
const { default: app, runMonitor } = await import("../dist/server/index.js");
const now = Date.parse("2026-11-25T10:00:00+09:00");
const start = now - 3600000, end = now + 5 * 3600000;
const candidate = (symbol = "005930", type = "주식") => ({ symbol, name: "테스트", type, momentum: 1.2, validPrice: () => true, reason: "테스트 조건" });
function context(time = now, price = 10000, volume = 1000, symbol = "005930", currency = "KRW") {
  return { now: time, regularStart: start, regularEnd: end, quotes: new Map([[symbol, { price, time }]]),
    books: new Map([[symbol, { currency, timestamp: new Date(time).toISOString(), asks: [{ price: String(price + 5), volume: String(volume) }], bids: [{ price: String(price - 5), volume: String(volume) }] }]]), candidates: [] };
}
test("ten-minute KR schedule has distinct stable IDs, opening delay and no late backfill", () => {
  const at = time => Date.parse("2026-11-25T" + time + ":00+09:00");
  assert.equal(slotTime(slotFor(at("09:00"))), at("09:03"));
  assert.equal(slotFor(at("09:10")).id, "2026-11-25T09:10");
  assert.equal(slotFor(at("09:20")).id, "2026-11-25T09:20");
  assert.equal(slotFor(at("09:14")), null);
  assert.equal(slotFor(at("16:10")), null);
  assert.equal(slotFor(at("16:00")).review, true);
});
test("upgrading preserves historical fills, cash and positions without retroactive charges", () => {
  const state = initialState(); state.cash = 9800000; state.positions.push({ symbol: "005930", quantity: 20, entry: 10000, price: 10100, quoteTime: now });
  state.trades.push({ id: "1", side: "BUY", quantity: 20, price: 10000, amount: 200000 });
  const old = structuredClone(state);
  upgradePaper(state, "KR", now);
  assert.equal(state.cash, old.cash); assert.deepEqual(state.trades, old.trades); assert.deepEqual(state.positions, old.positions);
  assert.equal(state.costs.commission, 0); assert.equal(state.versions.length, 1);
  upgradePaper(state, "KR", now + 1); assert.equal(state.versions.length, 1);
});
test("partial depth fills charge costs, cannot reuse a book snapshot, then settle a taxed sale", () => {
  const state = upgradePaper(initialState(), "KR", now);
  state.cash = 2000000; // Fixed cash isolates depth and fee arithmetic from allocation policy.
  const first = execute(state, { ...context(), candidates: [candidate()] });
  assert.equal(first.length, 1); assert.equal(first[0].quantity, 100);
  assert.equal(first[0].amount, 1000500); assert.equal(first[0].costs.commission, 151);
  assert.equal(state.paperOrders[0].status, "PARTIAL_FILLED");
  assert.equal(state.paperOrders[0].quantity, 199);
  assert.equal(state.cash, 999349);
  assert.deepEqual(execute(state, { ...context(), monitor: true }), []);
  const next = execute(state, { ...context(now + 60000), monitor: true });
  assert.equal(next[0].quantity, 99); assert.equal(state.paperOrders[0].status, "FILLED");
  assert.equal(state.positions[0].costKrw, 1991295);
  const sale = execute(state, { ...context(now + 120000, 10600, 5000), monitor: true });
  assert.equal(sale[0].quantity, 199); assert.equal(sale[0].source, "monitor");
  assert.equal(sale[0].costs.transactionTax, 4216);
  assert.equal(sale[0].realized, 112577);
  assert.equal(state.positions.length, 0); assert.equal(account(state).total, 2112577);
  assert.equal(state.costs.commission + state.costs.transactionTax + state.costs.fxSpread, 4833);
});
test("stale or out-of-limit books remain unfilled and expire instead of filling at last price", () => {
  const state = upgradePaper(initialState(), "KR", now);
  const ctx = context(); ctx.books.get("005930").timestamp = new Date(now - 31000).toISOString();
  assert.deepEqual(execute(state, { ...ctx, candidates: [candidate()] }), []);
  assert.equal(state.cash, 10000000); assert.equal(state.paperOrders[0].status, "PENDING"); assert.equal(state.alerts.length, 1);
  const bad = context(now + 60000); bad.books.get("005930").asks[0].price = "10500";
  assert.deepEqual(execute(state, { ...bad, monitor: true }), []);
  execute(state, { ...context(now + 301000), monitor: true });
  assert.equal(state.paperOrders[0].status, "EXPIRED"); assert.equal(state.trades.length, 0);
});
test("ETF sales exempt the simulated transaction tax; review never creates fills", () => {
  const state = upgradePaper(initialState(), "KR", now);
  execute(state, { ...context(now, 10000, 10000), candidates: [candidate("005930", "ETF")] });
  const rows = execute(state, { ...context(now + 60000, 10600, 10000), monitor: true });
  assert.equal(rows[0].costs.transactionTax, 0);
  const review = upgradePaper(initialState(), "KR", now);
  assert.deepEqual(execute(review, { ...context(), review: true, candidates: [candidate()] }), []);
});
test("USD fills split price, FX and explicit costs without double subtraction", () => {
  const time = Date.parse("2026-11-25T15:30:00Z"), state = upgradePaper(initialUsState(), "US", time);
  state.cash = 2000000;
  const slot = { date: "2026-11-25", regularStart: time - 3600000, regularEnd: time + 5 * 3600000 };
  const make = (when, price, rate) => ({ now: when, slot, quotes: new Map([["AAPL", { price, time: when }]]),
    books: new Map([["AAPL", { currency: "USD", timestamp: new Date(when).toISOString(), asks: [{ price: String(price + .01), volume: "1000" }], bids: [{ price: String(price - .01), volume: "1000" }] }]]),
    fx: { rate, from: when - 1000, until: when + 60000 } });
  executeUs(state, { ...make(time, 100, 1400), candidates: [candidate("AAPL")] });
  assert.equal(state.trades[0].quantity, 14); assert.equal(state.trades[0].cashAmount, 1964118);
  const sale = executeUs(state, { ...make(time + 60000, 106, 1500), candidates: [], monitor: true });
  assert.equal(sale[0].realized, 257220);
  assert.equal(sale[0].priceEffectKrw, 117208); assert.equal(sale[0].fxEffectKrw, 148386); assert.equal(sale[0].costEffectKrw, -8374);
  assert.equal(sale[0].priceEffectKrw + sale[0].fxEffectKrw + sale[0].costEffectKrw, sale[0].realized);
  const metrics = analyticsView(state, "US");
  assert.equal(metrics.attribution.total, sale[0].realized);
  assert.equal(usAccount(state).total, 2257220);
});
test("pending buys reserve cash and holding slots, configuration changes cancel them and version future fills", () => {
  const state = upgradePaper(initialState(), "KR", now);
  const candidates = Array.from({ length: 8 }, (_, i) => candidate("TEST" + i));
  execute(state, { now, regularStart: start, regularEnd: end, quotes: new Map(candidates.map(c => [c.symbol, { price: 10000, time: now }])), books: new Map(), candidates });
  assert.equal(state.paperOrders.length, 1); assert.equal(state.cash, 10000000);
  const oldVersion = state.paperModel.version;
  setPaperConfig(state, "KR", now + 1, { ...defaults("KR"), commissionBps: 2 });
  assert.notEqual(state.paperModel.version, oldVersion);
  assert.ok(state.paperOrders.every(o => o.status === "CANCELED"));
  assert.equal(state.versions.length, 2);
  assert.throws(() => setPaperConfig(state, "KR", now, { ...defaults("KR"), commissionBps: -1 }));
});
test("completed simulated orders and old trade records are retained beyond the UI page limit", () => {
  const state = upgradePaper(initialState(), "KR", now);
  state.paperOrders = Array.from({ length: 510 }, (_, i) => ({ id: "old-" + i, status: "FILLED" }));
  execute(state, { ...context(), monitor: true });
  assert.equal(state.paperOrders.length, 510);
  assert.equal(analyticsView(state, "KR").orders.length, 100);
});
test("risk metrics include drawdown and losing streak; tax is a separate annual provision", () => {
  const state = upgradePaper(initialUsState(), "US", now);
  state.cash = 13000000;
  state.history = [{ time: now, total: 11000000 }, { time: now + 1, total: 9000000 }];
  state.trades = [3100000, -50000, -50000, 0].map((realized, i) => ({ id: String(i + 1), time: now + i, side: "SELL", realized }));
  const a = analyticsView(state, "US");
  assert.ok(Math.abs(a.maxDrawdownPct - 100 * 2 / 11) < .0001);
  assert.equal(a.winRate, 25); assert.equal(a.averageLoss, 50000); assert.equal(a.maxLossStreak, 2);
  assert.equal(a.estimatedCapitalTax, 110000); assert.equal(a.afterEstimatedTax, 12890000);
  assert.equal(state.cash, 13000000);
});
test("benchmark comparisons start at observed data, include FX, and do not fabricate campaign history", () => {
  const state = upgradePaper(initialUsState(), "US", now);
  recordAnalytics(state, "US", now, [{ symbol: "SPY", name: "SPY", price: 100, fx: 1400, time: now }]);
  state.cash = 10500000;
  recordAnalytics(state, "US", now + 60000, [{ symbol: "SPY", name: "SPY", price: 110, fx: 1500, time: now + 60000 }]);
  const b = analyticsView(state, "US").benchmarks[0];
  assert.equal(b.since, now); assert.ok(Math.abs(b.strategyPct - 5) < .0001);
  assert.ok(Math.abs(b.returnPct - ((165000 / 140000) - 1) * 100) < .0001);
  recordAnalytics(state, "US", now + 200000, [{ symbol: "QQQ", price: 100, fx: 1400, time: now }]);
  assert.equal(Object.keys(state.benchmarks).length, 1);
});
test("monitor timer runs independently, reports heartbeat and stops", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const calls = [], beats = [];
  const stop = startMonitorBatch(async time => calls.push(time), time => beats.push(time));
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.deepEqual(calls, beats);
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 3);
  stop(); t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 3);
});
test("monitor initializes both markets without credentials; config changes enforce auth and origin", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_campaign.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../drizzle/0001_us_campaign.sql", import.meta.url), "utf8"));
  t.after(() => db.close());
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network without credentials"); });
  const env = { MARKETLAB_BATCH: true, DB: { prepare(sql) {
    const s = db.prepare(sql), bind = (...p) => ({ first: async () => s.get(...p) ?? null, run: async () => ({ meta: { changes: s.run(...p).changes } }) });
    return { ...bind(), bind };
  } } };
  await runMonitor(env, now);
  const call = (path, body, auth = true, origin = "http://localhost") => app.fetch(new Request("http://localhost" + path, {
    headers: { ...(auth ? { "oai-authenticated-user-id": "test-owner" } : {}), ...(body ? { "content-type": "application/json", origin } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }), env);
  const kr = await (await call("/api/state")).json(), us = await (await call("/api/us/state")).json();
  assert.equal(kr.analytics.model.enabled, true); assert.equal(us.analytics.model.enabled, true);
  assert.equal(kr.analytics.operations.status, "waiting"); assert.equal(us.totals.total, 10000000);
  assert.equal((await call("/api/model", defaults("KR"), false)).status, 401);
  assert.equal((await call("/api/model", defaults("KR"), true, "https://other.example")).status, 403);
  assert.equal((await call("/api/model", { ...defaults("KR"), taxBps: -1 })).status, 400);
  assert.equal((await call("/api/us/model", { ...defaults("US"), fxSpreadBps: 20 })).status, 200);
  assert.equal((await (await call("/api/us/state")).json()).analytics.model.config.fxSpreadBps, 20);
  assert.equal((await call("/api/live/orders")).status, 404);
  const cachedKr = JSON.parse(db.prepare("SELECT state FROM campaign WHERE id=1").get().state);
  cachedKr.positions = [{ symbol: "005930", quantity: 1, entry: 70000, price: 71000, quoteTime: now }];
  db.prepare("UPDATE campaign SET state=?,access_token=? WHERE id=1").run(JSON.stringify(cachedKr), "not-a-real-token");
  const cachedUs = JSON.parse(db.prepare("SELECT state FROM us_campaign WHERE id=1").get().state);
  cachedUs.positions = [{ symbol: "AAPL", quantity: 1, entryUsd: 100, priceUsd: 101, price: 141400, quoteTime: now, fxRate: 1400, valueKrw: 141400, costKrw: 140000 }];
  db.prepare("UPDATE us_campaign SET state=? WHERE id=1").run(JSON.stringify(cachedUs));
  const screens = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? "/api/quotes" : "/api/us/quotes")));
  assert.ok(screens.every(response => response.status === 200));
  assert.equal((await screens[0].json()).quotes.AAPL.priceUsd, 101);
  const cache = await screens[1].json(); assert.equal(cache.source, "server-monitor"); assert.equal(cache.quotes["005930"].price, 71000);
});

test("authenticated monitor protects KR and US holdings, shares tokens and rolls back invalid FX", async t => {
  let monitorNow = now, invalidFx = false;
  const base = performance.now(); t.mock.method(Date, "now", () => monitorNow + Math.floor(performance.now() - base));
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_campaign.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../drizzle/0001_us_campaign.sql", import.meta.url), "utf8")); t.after(() => db.close());
  const env = { MARKETLAB_KEY: "01".repeat(32), MARKETLAB_BATCH: true, DB: { prepare(sql) {
    const s = db.prepare(sql), bind = (...p) => ({ first: async () => s.get(...p) ?? null, run: async () => ({ meta: { changes: s.run(...p).changes } }) }); return { ...bind(), bind };
  } } };
  let orderCalls = 0;
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.hostname, "openapi.tossinvest.com");
    const timestamp = new Date(Date.now()).toISOString();
    if (url.pathname === "/oauth2/token") return Response.json({ access_token: "fake-monitor-token", expires_in: 3600 });
    if (url.pathname.includes("orders")) { orderCalls++; throw new Error("No actual order calls"); }
    assert.ok(!options.method || options.method === "GET");
    const route = url.pathname.replace("/api/v1/", ""); let result;
    if (route === "prices") result = url.searchParams.get("symbols").split(",").map(symbol => ({ symbol, currency: /^[A-Z]/.test(symbol) ? "USD" : "KRW", lastPrice: /^[A-Z]/.test(symbol) ? "106" : "10600", timestamp }));
    else if (route === "market-calendar/KR") { const date = url.searchParams.get("date"); result = { today: { date, integrated: { regularMarket: { startTime: date + "T09:00:00+09:00", singlePriceAuctionStartTime: date + "T15:20:00+09:00", endTime: date + "T15:30:00+09:00" } } } }; }
    else if (route === "market-calendar/US") { const date = url.searchParams.get("date"); result = { today: { date, regularMarket: { startTime: new Date(usLocalTime(date, "09:30")).toISOString(), endTime: new Date(usLocalTime(date, "16:00")).toISOString() } } }; }
    else if (route === "orderbook") { const us = /^[A-Z]/.test(url.searchParams.get("symbol")); result = { currency: us ? "USD" : "KRW", timestamp, asks: [{ price: us ? "106.01" : "10605", volume: "1000" }], bids: [{ price: us ? "105.99" : "10595", volume: "1000" }] }; }
    else if (route === "exchange-rate") result = { baseCurrency: "USD", quoteCurrency: "KRW", midRate: "1500", validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + (invalidFx ? -1 : 60000)).toISOString() };
    else if (route === "market-indicators/prices") result = [{ symbol: "KOSPI", lastPrice: "3000", timestamp }];
    else throw new Error("Unexpected endpoint " + route);
    return Response.json({ result });
  });
  const connect = await app.fetch(new Request("http://localhost/api/connect", { method: "POST", headers: { origin: "http://localhost", "oai-authenticated-user-id": "owner", "content-type": "application/json" }, body: JSON.stringify({ id: "fake", secret: "fake" }) }), env);
  assert.equal(connect.status, 200);
  const state = initialState(); state.cash = 9850000;
  state.positions.push({ symbol: "005930", name: "테스트", type: "주식", quantity: 15, entry: 10000, price: 10000, quoteTime: now - 10000 });
  state.trades.push({ id: "1", time: now - 10000, side: "BUY", symbol: "005930", quantity: 15, price: 10000, amount: 150000, realized: 0, total: 10000000 });
  const originalTrade = structuredClone(state.trades[0]);
  upgradePaper(state, "KR", now - 3600000);
  db.prepare("UPDATE campaign SET state=? WHERE id=1").run(JSON.stringify(state));
  await runMonitor(env, Date.now());
  const saved = JSON.parse(db.prepare("SELECT state FROM campaign WHERE id=1").get().state);
  assert.deepEqual(saved.trades[0], originalTrade);
  assert.equal(saved.trades[1].source, "monitor"); assert.equal(saved.trades[1].realized, 8584);
  assert.equal(saved.cash, 10008584); assert.equal(saved.positions.length, 0);
  assert.ok(saved.alerts.some(a => a.key.startsWith("missed:")));
  assert.ok(saved.alerts.some(a => a.key.startsWith("protective-fill:")));
  assert.equal(saved.operations.status, "monitoring"); assert.equal(orderCalls, 0);
  assert.ok(saved.benchmarks["069500"]);
  await runMonitor(env, Date.now());
  assert.equal(JSON.parse(db.prepare("SELECT state FROM campaign WHERE id=1").get().state).trades.length, 2);
  monitorNow = Date.parse("2026-11-25T15:30:00Z");
  const us = initialUsState(); us.cash = 8600000;
  us.positions.push({ symbol: "AAPL", name: "애플", type: "주식", quantity: 10, entryUsd: 100, entry: 140000, priceUsd: 100,
    price: 140000, entryFx: 1400, fxRate: 1400, costKrw: 1400000, valueKrw: 1400000, quoteTime: monitorNow - 10000 });
  db.prepare("UPDATE us_campaign SET state=? WHERE id=1").run(JSON.stringify(us));
  await runMonitor(env, Date.now());
  const usSaved = JSON.parse(db.prepare("SELECT state FROM us_campaign WHERE id=1").get().state);
  assert.equal(usSaved.trades[0].realized, 186670); assert.equal(usSaved.trades[0].source, "monitor");
  assert.equal(usSaved.positions.length, 0); assert.equal(usSaved.fx.rate, 1500);
  assert.ok(usSaved.benchmarks.SPY); assert.ok(usSaved.benchmarks.QQQ);
  invalidFx = true;
  monitorNow += 1000; // A later quote check, outside the shared short read cache.
  await runMonitor(env, Date.now());
  const failed = JSON.parse(db.prepare("SELECT state FROM us_campaign WHERE id=1").get().state);
  assert.equal(failed.operations.status, "error"); assert.deepEqual(failed.trades, usSaved.trades); assert.equal(failed.cash, usSaved.cash);
  assert.ok(failed.alerts.some(a => a.key === "monitor-error")); assert.equal(orderCalls, 0);
});


test("KR and US buys can exceed 20 percent, ignore old allocation factors and never overspend cash", () => {
  for (const market of ["KR", "US"]) {
    const state = upgradePaper(market === "KR" ? initialState() : initialUsState(), market, now);
    const ctx = context(now, 10000, 100000, "TEST", market === "US" ? "USD" : "KRW");
    const args = { ...ctx, candidates: [{ ...candidate("TEST"), allocation: .65 }] };
    if (market === "KR") execute(state, args);
    else executeUs(state, { ...args, slot: { date: "2026-11-25", regularStart: start, regularEnd: end }, fx: { rate: 1, from: now - 1000, until: now + 60000 } });
    assert.equal(state.positions.length, 1);
    assert.ok(state.trades[0].cashAmount > 9900000);
    assert.ok(state.cash >= 0 && state.cash < 100000);
    assert.equal(state.paperOrders[0].status, "FILLED");
  }
});
test("allocation policy migration preserves fills and sells, cancels old pending buys exactly once", () => {
  const state = upgradePaper(initialState(), "KR", now);
  execute(state, { ...context(), books: new Map(), candidates: [candidate()] });
  const before = structuredClone(state);
  state.paperModel.code = "paper-v2-10m";
  state.paperOrders.push({ id: "old-sell", side: "SELL", status: "PENDING" });
  upgradePaper(state, "KR", now + 1);
  assert.equal(state.paperOrders[0].status, "CANCELED");
  assert.equal(state.paperOrders[1].status, "PENDING");
  assert.equal(state.cash, before.cash);
  assert.deepEqual(state.trades, before.trades);
  assert.deepEqual(state.positions, before.positions);
  assert.equal(state.versions.length, before.versions.length + 1);
  upgradePaper(state, "KR", now + 2);
  assert.equal(state.versions.length, before.versions.length + 1);
});


test("resting entries wait for executable prices, reserve cash, partially fill and expire in both markets", () => {
  for (const market of ["KR", "US"]) {
    const state = upgradePaper(market === "KR" ? initialState() : initialUsState(), market, now);
    const fx = market === "US" ? {rate:1400,from:now-1000,until:end} : null;
    const run = (time, price, volume=1000, candidates=[]) => {
      const ctx=context(time,price,volume,"005930",market === "US" ? "USD" : "KRW");
      ctx.books.get("005930").asks[0].price=String(price+.01); ctx.books.get("005930").bids[0].price=String(price-.01);
      return market === "KR" ? execute(state,{...ctx,candidates,monitor:!candidates.length}) : executeUs(state,{...ctx,slot:{regularStart:start,regularEnd:end},fx,candidates,monitor:!candidates.length});
    };
    assert.deepEqual(run(now,100,1000,[{...candidate(),momentum:.5}]),[]);
    const order=state.paperOrders[0]; assert.equal(order.executionStyle,"RESTING_ENTRY");
    assert.equal(order.limitPrice,99.8); assert.equal(state.cash,10000000);
    run(now+60000,100,1000,[{...candidate("OTHER"),momentum:.5}]);
    assert.equal(state.paperOrders.filter(o=>o.side==="BUY").length,1);
    assert.equal(run(now+120000,99.7,100)[0].quantity,10);
    assert.equal(order.status,"PARTIAL_FILLED"); assert.ok(state.cash>=0);
    run(now+900000,99.7,100);
    assert.equal(order.status,"EXPIRED"); assert.equal(order.filledQuantity,10);
    assert.ok(state.paperOrders.some(o=>o.executionStyle==="RESTING_TAKE_PROFIT"));
  }
});

test("preplaced profit target fills from bids even before last trade reaches target, then stop overrides residual target", () => {
  const state=upgradePaper(initialState(),"KR",now);
  execute(state,{...context(now,10000,10000),candidates:[candidate()]});
  execute(state,{...context(now+60000,10100,10000),monitor:true});
  const target=state.paperOrders.find(o=>o.executionStyle==="RESTING_TAKE_PROFIT");
  assert.ok(target); assert.equal(target.status,"PENDING"); assert.equal(target.expiresAt,end);
  const ctx=context(now+120000,target.limitPrice-1,100);
  ctx.books.get("005930").bids[0].price=String(target.limitPrice);
  const fill=execute(state,{...ctx,monitor:true});
  assert.equal(fill[0].quantity,10); assert.equal(fill[0].executionStyle,"RESTING_TAKE_PROFIT");
  assert.equal(target.status,"PARTIAL_FILLED");
  execute(state,{...context(now+180000,9700,10000),monitor:true});
  assert.equal(target.status,"CANCELED"); assert.equal(state.positions.length,0);
  assert.match(state.trades.at(-1).reason,/손절/);
});

test("adverse news cancels an unfilled entry and replaces an existing profit target; duplicate targets never accumulate", () => {
  const s=upgradePaper(initialState(),"KR",now);
  execute(s,{...context(),candidates:[{...candidate(),momentum:.5}]});
  s.eventWatch={blocks:{'005930':{until:now+3600000}}};
  execute(s,{...context(now+60000,9950),monitor:true});
  assert.equal(s.paperOrders[0].status,"CANCELED"); assert.equal(s.trades.length,0);
  delete s.eventWatch;
  execute(s,{...context(now+120000,10000,10000),candidates:[candidate()]});
  execute(s,{...context(now+180000,10100),monitor:true});
  execute(s,{...context(now+240000,10100),monitor:true});
  const targets=s.paperOrders.filter(o=>o.executionStyle==="RESTING_TAKE_PROFIT"); assert.equal(targets.length,1);
  execute(s,{...context(now+300000,10000,10000),monitor:true,openingExit:()=>"장중 중요 공시 보호 매도"});
  assert.equal(targets[0].status,"CANCELED"); assert.equal(s.positions.length,0);
  assert.equal(s.trades.at(-1).source,"event");
});

test("stop remainder follows a fresh executable bid and re-entry waits after the last stop fill", () => {
  const s=upgradePaper(initialState(),"KR",now);
  s.cash=101000;
  execute(s,{...context(),candidates:[candidate()]});
  const down=context(now+10000,9600);
  down.books.get("005930").bids[0].price="9500";
  assert.equal(execute(s,down).length,0);
  const crash=context(now+15000,9400);
  const sale=execute(s,crash);
  assert.equal(sale[0].price,9395);
  assert.equal(s.paperOrders.at(-1).reference,9600);
  execute(s,{...context(now+20000),candidates:[candidate()]});
  assert.equal(s.entryObservations.at(-1).decision,"손절 후 30분 대기");
});
test("overheated candidate records alternatives and later quote without spending cash", () => {
  const s=upgradePaper(initialState(),"KR",now);
  execute(s,{...context(),candidates:[{...candidate(),momentum:3}]});
  const row=s.entryObservations[0];
  assert.equal(s.paperOrders.length,0);
  assert.deepEqual(Object.values(row.probes).map(p=>p.quantity),[3,0,1]);
  execute(s,context(now+600000,9900));
  assert.equal(row.afterPrice,9900);
  assert.deepEqual(Object.values(row.probes).map(p=>p.quantity),[3,3,3]);
  assert.equal(s.cash,10000000);
});
