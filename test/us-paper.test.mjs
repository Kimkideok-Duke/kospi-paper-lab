import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fresh } from "../server/engine.mjs";
import { usDate, usLocalTime, usSlots, usSlotFor, nextUsSlot, initialUsState, executeUs, usAccount, krwAmount, usdQuoteMap, validFx } from "../server/us-engine.mjs";
import { scanUs } from "../server/us-paper.mjs";
import { startUsBatch } from "../server/us-batch.mjs";
import "../scripts/build.mjs";
const { default: app, runUsSlot } = await import("../dist/server/index.js");

const date = "2026-11-25";
const at = time => usLocalTime(date, time);
const day = (date, close = "16:00") => ({ date, regularMarket: {
  startTime: new Date(usLocalTime(date, "09:30")).toISOString(), endTime: new Date(usLocalTime(date, close)).toISOString(),
} });
const calendar = { today: day(date), previousBusinessDay: day("2026-11-24"), nextBusinessDay: day("2026-11-27", "13:00") };
const fxAt = (now, rate = 1400) => ({ rate, from: now - 1000, until: now + 60000 });
const candidate = (symbol = "AAPL") => ({ symbol, name: "애플", type: "주식", validPrice: () => true, reason: "테스트 모의 조건" });

test("US date and opening time follow New York daylight saving rather than Korean midnight", () => {
  assert.equal(new Date(usLocalTime("2026-03-06", "09:30")).toISOString(), "2026-03-06T14:30:00.000Z");
  assert.equal(new Date(usLocalTime("2026-03-09", "09:30")).toISOString(), "2026-03-09T13:30:00.000Z");
  assert.equal(new Date(usLocalTime("2026-10-30", "09:30")).toISOString(), "2026-10-30T13:30:00.000Z");
  assert.equal(new Date(usLocalTime("2026-11-02", "09:30")).toISOString(), "2026-11-02T14:30:00.000Z");
  assert.equal(usDate(Date.parse("2026-11-26T04:00:00+09:00")), "2026-11-25");
});

test("actual US calendar handles opening delay, hourly cadence, holidays and early close", () => {
  const slots = usSlots(calendar.today);
  assert.equal(slots.length, 40);
  assert.equal(slots[0].time, at("09:33"));
  assert.equal(slots[1].time, at("09:40"));
  assert.equal(slots.at(-1).time, at("16:00"));
  assert.equal(slots.at(-1).review, true);
  assert.equal(usSlotFor(calendar, at("09:32")), null);
  assert.equal(usSlotFor(calendar, at("09:33")).opening, true);
  assert.equal(usSlotFor(calendar, at("10:54")), null); // Never backfill a missed ten-minute session.
  const holiday = { today: { date: "2026-11-26", regularMarket: null }, nextBusinessDay: day("2026-11-27", "13:00") };
  assert.deepEqual(usSlots(holiday.today), []);
  assert.equal(nextUsSlot(holiday, usLocalTime("2026-11-26", "12:00")), usLocalTime("2026-11-27", "09:33"));
  const early = usSlots(day("2026-11-27", "13:00"));
  assert.equal(early.length, 22);
  assert.equal(early.at(-1).time, usLocalTime("2026-11-27", "13:00"));
  assert.equal(early.at(-1).review, true);
  assert.deepEqual(usSlots(day("2026-12-25")), []);
  assert.equal(usSlotFor(calendar, at("08:00"), "manual-id"), null);
  assert.equal(usSlotFor(calendar, at("16:00"), "manual-id"), null);
});

test("US portfolio starts independently at KRW 10m and settles each trade at its own FX rate", () => {
  const state = initialUsState(), now = at("10:30"), slot = usSlotFor(calendar, now);
  assert.equal(usAccount(state).total, 10_000_000);
  const buys = executeUs(state, { now, slot, quotes: new Map([["AAPL", { price: 100, time: now }]]), fx: fxAt(now), candidates: [candidate()] });
  assert.equal(buys.length, 1);
  assert.equal(buys[0].quantity, 71);
  assert.equal(buys[0].amount, 9_940_000);
  assert.equal(buys[0].priceUsd, 100);
  assert.equal(buys[0].fxRate, 1400);
  assert.equal(state.cash, 60_000);
  const later = at("11:30");
  const sells = executeUs(state, { now: later, slot: usSlotFor(calendar, later),
    quotes: new Map([["AAPL", { price: 106, time: later }]]), fx: fxAt(later, 1500), candidates: [] });
  assert.equal(sells[0].amount, 11_289_000);
  assert.equal(sells[0].realized, 1_349_000); // Includes FX movement as well as USD price return.
  assert.equal(usAccount(state).total, 11_349_000);
  assert.equal(usAccount(state).realized, 1_349_000);
  assert.equal(state.positions.length, 0);
});

test("USD price triggers do not confuse an FX move with a share-price stop loss", () => {
  const state = initialUsState(), now = at("10:30");
  executeUs(state, { now, slot: usSlotFor(calendar, now), quotes: new Map([["AAPL", { price: 100, time: now }]]), fx: fxAt(now), candidates: [candidate()] });
  const later = at("11:30");
  const trades = executeUs(state, { now: later, slot: usSlotFor(calendar, later), quotes: new Map([["AAPL", { price: 100, time: later }]]), fx: fxAt(later, 1300), candidates: [] });
  assert.equal(trades.length, 0);
  assert.equal(usAccount(state).pnl, -710_000);
  assert.equal(usAccount(state).realized, 0);
});

test("won rounding is deterministic, no negative cash or more than five holdings", () => {
  assert.equal(krwAmount(1.01, 3, 1400.1234, true), 4243);
  assert.equal(krwAmount(1.01, 3, 1400.1234), 4242);
  const state = initialUsState(), now = at("10:30");
  const candidates = Array.from({ length: 7 }, (_, i) => candidate("TEST" + i));
  const quotes = new Map(candidates.map(c => [c.symbol, { price: 0.71, time: now }]));
  executeUs(state, { now, slot: usSlotFor(calendar, now), quotes, fx: fxAt(now, 1400.1234), candidates });
  assert.equal(state.positions.length, 1);
  assert.ok(state.cash >= 0 && Number.isInteger(state.cash));
  assert.ok(state.trades.every(trade => Number.isInteger(trade.amount) && trade.amount <= 10_000_000));
});

test("stale USD prices, invalid FX, closed sessions and closing review cannot generate fills", () => {
  const now = at("10:30"), slot = usSlotFor(calendar, now);
  assert.equal(usdQuoteMap([{ symbol: "AAPL", currency: "KRW", lastPrice: "100", timestamp: new Date(now).toISOString() }]).size, 0);
  assert.throws(() => validFx({ baseCurrency: "USD", quoteCurrency: "KRW", midRate: "1400", validFrom: new Date(now - 10000).toISOString(), validUntil: new Date(now - 1).toISOString() }, now));
  const state = initialUsState();
  assert.deepEqual(executeUs(state, { now, slot, quotes: new Map([["AAPL", { price: 100, time: now - 91000 }]]), fx: fxAt(now), candidates: [candidate()] }), []);
  assert.deepEqual(executeUs(state, { now: at("16:00"), slot: usSlotFor(calendar, at("16:00")), quotes: new Map([["AAPL", { price: 100, time: at("16:00") }]]), fx: fxAt(at("16:00")), candidates: [candidate()] }), []);
  assert.equal(state.cash, 10_000_000);
});

function fakeClient(now, overrides = {}) {
  const paths = [];
  return { missing: new Set(), paths,
    async get(path, params = {}) {
      paths.push({ path, params });
      if (overrides[path]) return overrides[path](params);
      if (path === "stocks/all") return [{ symbol: "AAPL", name: "애플", securityType: "STOCK", isCommonShare: true }];
      if (path === "rankings") return { rankedAt: new Date(now).toISOString(), rankings: [{ symbol: "AAPL", currency: "USD", tradingAmount: "100000000", price: { basePrice: "99" } }] };
      if (path === "prices") return params.symbols.split(",").map(symbol => ({ symbol, currency: "USD", lastPrice: "100", timestamp: new Date(now).toISOString() }));
      if (path === "exchange-rate") return { baseCurrency: "USD", quoteCurrency: "KRW", midRate: "1400", validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60000).toISOString() };
      if (path === "candles") return { candles: Array.from({ length: 5 }, (_, i) => ({ currency: "USD", timestamp: new Date(now - i * 60000).toISOString(), closePrice: i ? "99.5" : "100", volume: "10000" })) };
      if (path === "orderbook") return { currency: "USD", timestamp: new Date(now).toISOString(), asks: [{ price: "100.01", volume: "100" }], bids: [{ price: "99.99", volume: "100" }] };
      if (path.endsWith("/warnings")) return [];
      throw new Error("Unexpected read-only endpoint " + path);
    } };
}

test("US scan accepts fractional USD prices and missing US price limits, uses only read-only market data", async t => {
  const now = at("10:30");
  t.mock.method(Date, "now", () => now);
  const state = initialUsState(), client = fakeClient(now);
  const result = await scanUs(state, usSlotFor(calendar, now), client, calendar);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].symbol, "AAPL");
  assert.equal(result.trades[0].fxRate, 1400);
  assert.ok(client.paths.some(call => call.path === "rankings" && call.params.marketCountry === "US"));
  assert.ok(!client.paths.some(call => /orders|accounts|holdings|price-limits/.test(call.path)));
  assert.equal(state.latest.universe, 1);
  assert.equal(state.latest.observed, 1);
});

test("missing rankings stop new buys; stale/missing FX discards a US scan before any paper fills", async t => {
  const now = at("10:30"); t.mock.method(Date, "now", () => now);
  const state = initialUsState();
  const result = await scanUs(state, usSlotFor(calendar, now), fakeClient(now, { rankings: () => null }), calendar);
  assert.equal(result.trades.length, 0);
  const invalid = initialUsState();
  await assert.rejects(scanUs(invalid, usSlotFor(calendar, now), fakeClient(now, { "exchange-rate": () => ({ midRate: "1400" }) }), calendar), /환율/);
  assert.equal(invalid.cash, 10_000_000);
  assert.equal(invalid.trades.length, 0);
});

test("US batch runs on the server without a browser and stops cleanly", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at("09:32") });
  const calls = [];
  const stop = startUsBatch(async now => { calls.push(now); return { status: "outside" }; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1], at("09:33"));
  stop();
  t.mock.timers.tick(120_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test("US API persists a separate account, shares one token, and deduplicates manual requests", async t => {
  const realStart = performance.now(), now = at("10:30");
  t.mock.method(Date, "now", () => now + Math.floor(performance.now() - realStart));
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_campaign.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../drizzle/0001_us_campaign.sql", import.meta.url), "utf8"));
  t.after(() => db.close());
  const env = { MARKETLAB_KEY: "01".repeat(32), MARKETLAB_BATCH: true, DB: {
    prepare(sql) {
      const statement = db.prepare(sql);
      const bind = (...parameters) => ({ first: async () => statement.get(...parameters) ?? null,
        run: async () => ({ meta: { changes: statement.run(...parameters).changes } }) });
      return { ...bind(), bind };
    } } };
  let tokenRequests = 0, orderRequests = 0, calendarRequests = 0;
  const fake = fakeClient(now);
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, "openapi.tossinvest.com");
    if (url.pathname === "/oauth2/token") { tokenRequests++; return Response.json({ access_token: "only-a-test-token", expires_in: 3600 }); }
    if (url.pathname.includes("orders")) { orderRequests++; throw new Error("No actual order endpoint may be called"); }
    assert.ok(!options.method || options.method === "GET");
    const path = url.pathname.replace("/api/v1/", "");
    if (path === "market-calendar/US") { calendarRequests++; return Response.json({ result: calendar }); }
    return Response.json({ result: await fake.get(path, Object.fromEntries(url.searchParams)) });
  });
  const request = (path, payload, auth = true, origin = "http://localhost") => app.fetch(new Request("http://localhost" + path, {
    headers: { ...(auth ? { "oai-authenticated-user-id": "test-owner" } : {}), ...(payload ? { origin, "content-type": "application/json" } : {}) },
    ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
  }), env);
  assert.equal((await request("/api/us/state", undefined, false)).status, 401);
  const beforeConnection = await (await request("/api/us/state")).json();
  assert.equal(beforeConnection.initial, 10_000_000);
  assert.equal(beforeConnection.connected, false);
  assert.equal((await request("/api/connect", { id: "fake-id", secret: "fake-secret" })).status, 200);
  const domesticBefore = db.prepare("SELECT state FROM campaign WHERE id=1").get().state;
  const payload = { requestId: "00000000-0000-4000-8000-000000000001" };
  assert.equal((await request("/api/us/manual-run", payload, true, "https://other.example")).status, 403);
  const result = await (await request("/api/us/manual-run", payload)).json();
  assert.equal(result.trades.length, 1, JSON.stringify(result));
  const repeated = await (await request("/api/us/manual-run", payload)).json();
  assert.equal(repeated.trades[0].id, result.trades[0].id);
  const us = await (await request("/api/us/state")).json();
  assert.equal(us.market, "US");
  assert.equal(us.connected, true);
  assert.equal(us.trades.length, 1);
  assert.equal(us.next, at("10:40"));
  assert.equal(db.prepare("SELECT state FROM campaign WHERE id=1").get().state, domesticBefore);
  assert.equal(tokenRequests, 1);
  assert.equal(calendarRequests, 1);
  assert.equal(orderRequests, 0);
  const auto = await runUsSlot(env, Date.now());
  assert.equal(auto.status, "ok");
  assert.equal((await runUsSlot(env, Date.now())).status, "duplicate");
  assert.equal((await request("/us")).status, 200);
  assert.equal((await request("/us/trades")).status, 200);
});
