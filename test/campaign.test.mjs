import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { INITIAL, account, execute, initialState, slotFor, slotTime } from "../server/engine.mjs";
import { collectOpeningNews, openingExitReason, openingSignal } from "../server/us-news.mjs";
import { startBatch } from "../server/batch.mjs";
import "../scripts/build.mjs";

const { default: app, runSlot } = await import("../dist/server/index.js");
const at = (hhmm, day = "2026-11-25") => Date.parse(day + "T" + hhmm + ":00+09:00");
const start = at("09:00");
const end = at("15:20");

test("campaign sessions use Korean time and only a short execution window", () => {
  assert.equal(slotFor(at("08:59")), null);
  assert.equal(slotFor(at("09:00")).hour, 9);
  assert.equal(slotTime(slotFor(at("09:00"))), at("09:03"));
  assert.equal(slotFor(at("10:15")), null);
  assert.equal(slotFor(at("16:00")).review, true);
  assert.equal(slotFor(at("09:00", "2026-11-28")), null);
  assert.equal(slotFor(at("09:00", "2026-12-25")), null);
});

test("portfolio caps holdings, accounts for gross amounts, and never trades on stale prices or at review", () => {
  const state = initialState();
  const time = at("10:00");
  const candidates = Array.from({ length: 8 }, (_, i) => ({ symbol: String(i), name: "Sample",
    type: i === 0 ? "ETF" : "주식", reason: "Test", validPrice: () => true }));
  const quotes = new Map(candidates.map(({ symbol }) => [symbol, { price: 10000, time }]));
  assert.deepEqual(execute(state, { now: time + 91000, regularStart: start, regularEnd: end, quotes, candidates }), []);
  assert.equal(execute(state, { now: time, regularStart: start, regularEnd: end, quotes, candidates, review: true }).length, 0);
  assert.equal(execute(state, { now: time, regularStart: start, regularEnd: end, quotes, candidates }).length, 5);
  assert.equal(state.positions[0].type, "ETF");
  assert.equal(account(state).cash, 0);
  assert.equal(account(state).total, INITIAL);

  const next = at("11:00");
  const sells = execute(state, { now: next, regularStart: start, regularEnd: end,
    quotes: new Map([["0", { price: 10800, time: next }]]), candidates });
  assert.equal(sells.length, 1);
  assert.equal(sells[0].realized, 160000);
  assert.equal(sells[0].amount, 2160000);
  assert.equal(sells[0].total, 10160000);
  assert.equal(sells[0].totalPnl, 160000);
});

test("opening batch uses weekend U.S. headlines to reduce ETF position size and persists its evidence", async t => {
  const monday = "2026-11-30";
  const mondayAt = clock => at(clock, monday);
  const previousClose = at("15:30", "2026-11-27");
  t.mock.timers.enable({ apis: ["Date"], now: mondayAt("09:04") });
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../drizzle/0000_campaign.sql", import.meta.url), "utf8"));
  t.after(() => database.close());
  const env = { MARKETLAB_KEY: "01".repeat(32), DB: {
    prepare(sql) {
      const stmt = database.prepare(sql);
      const bind = (...parameters) => ({
        first: async () => stmt.get(...parameters), run: async () => ({ meta: stmt.run(...parameters) }),
      });
      return { ...bind(), bind };
    },
  } };
  const symbol = "069500";
  let outcome = 10000;
  const result = value => Response.json({ result: value });
  const time = () => new Date(Date.now()).toISOString();
  let newsRequests = 0;
  const called = t.mock.method(globalThis, "fetch", async url => {
    const { hostname, pathname, searchParams } = new URL(url);
    if (hostname !== "openapi.tossinvest.com") {
      newsRequests += 1;
      const item = (title, link, published) => "<item><title>" + title + "</title><link>" + link
        + "</link><pubDate>" + new Date(published).toUTCString() + "</pubDate></item>";
      let headlines = "";
      if (hostname === "feeds.npr.org") {
        headlines = item("Wall Street sinks after weak economic data", "https://www.npr.org/story/us-stocks", at("02:00", "2026-11-28"));
      }
      if (hostname === "www.cnbc.com") {
        headlines = item("Nvidia shares rise after earnings", "https://www.cnbc.com/nvidia?source=rss", at("05:00", "2026-11-28")) +
          item("Nasdaq rallies early", "https://www.cnbc.com/before", previousClose - 1000) +
          item("Nasdaq rises after opening preview", "https://www.cnbc.com/future", mondayAt("09:01"));
      }
      return new Response("<rss><channel>" + headlines + "</channel></rss>");
    }
    if (pathname === "/oauth2/token") return Response.json({ access_token: "only-test-token", expires_in: 3600 });
    const route = pathname.replace("/api/v1/", "");
    if (route === "prices") return result(searchParams.get("symbols").split(",").map(symbol => ({ symbol, currency: "KRW", lastPrice: String(outcome), timestamp: time() })));
    if (route === "market-calendar/KR") return result({ today: { date: monday, integrated: { regularMarket: {
      startTime: new Date(mondayAt("09:00")).toISOString(), singlePriceAuctionStartTime: new Date(mondayAt("15:20")).toISOString() } } },
      previousBusinessDay: { date: "2026-11-27", integrated: { regularMarket: { endTime: new Date(previousClose).toISOString() } } } });
    if (route === "stocks/all") return result([{ symbol, securityType: "ETF", name: "ETF 예시" }]);
    if (route === "rankings") return result({ rankedAt: time(), rankings: [{ symbol, price: { basePrice: "9800" }, tradingAmount: "200000000" }] });
    if (route === "candles") return result({ candles: Array.from({ length: 5 }, (_, i) => ({
      timestamp: new Date(Date.now() - 60000 * i).toISOString(), closePrice: String(10000 - 20 * i), volume: "2500",
    })) });
    if (route === "orderbook") return result({ timestamp: time(), bids: [{ price: "9995", volume: "300" }], asks: [{ price: "10005", volume: "300" }] });
    if (route === "price-limits") return result({ timestamp: time(), upperLimitPrice: "13000", lowerLimitPrice: "7000" });
    if (route.endsWith("/warnings")) return result([]);
    if (route === "trades") return result([{ timestamp: time(), volume: "50" }]);
    if (route.endsWith("/investor-trading") || route.endsWith("/program-trades")) return result({ records: [] });
    if (route === "market-indicators/prices") return result([]);
    if (route === "market-indicators/KOSPI/candles") return result({ candles: [] });
    if (route === "exchange-rate") return result({ midRate: "1400", validFrom: time() });
    throw Error("unexpected fixture route " + route);
  });
  const api = (route, body, signedIn = true) => app.fetch(new Request("https://test.local" + route, body === undefined
    ? { headers: signedIn ? { "oai-authenticated-user-id": "owner" } : {} }
    : { method: "POST", headers: { "oai-authenticated-user-id": "owner", "content-type": "application/json", origin: "https://test.local" },
      body: JSON.stringify(body) }), env);
  assert.equal((await api("/api/state", undefined, false)).status, 401);
  const hosted = await (await api("/api/state")).json();
  assert.equal(hosted.batchEnabled, false);
  assert.equal(hosted.next, null);
  assert.equal(hosted.canCheckIp, false);
  assert.equal((await api("/api/connection-ip")).status, 404);
  assert.equal((await api("/api/automation/run", {})).status, 404);
  assert.equal((await api("/api/run", {})).status, 404);
  assert.equal((await api("/mcp", { method: "tools/list" })).status, 404);
  env.MARKETLAB_BATCH = true;
  env.connectionIp = async () => "203.0.113.15";
  const selfHosted = await (await api("/api/state")).json();
  assert.equal(selfHosted.batchEnabled, true);
  assert.equal(selfHosted.next, mondayAt("10:00"));
  assert.equal(selfHosted.canCheckIp, true);
  assert.equal((await api("/api/connection-ip", undefined, false)).status, 401);
  const ipResponse = await api("/api/connection-ip");
  assert.equal(ipResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ipResponse.json(), { ip: "203.0.113.15" });
  assert.equal((await runSlot(env)).status, "waiting");
  assert.equal((await api("/api/connect", { id: "sample-id", secret: "sample-key" })).status, 200);
  const storage = JSON.stringify(database.prepare("SELECT * FROM campaign").get());
  assert.ok(!storage.includes("sample-key"));
  assert.ok(!storage.includes("only-test-token"));
  const first = await runSlot(env);
  assert.equal(first.status, "ok");
  assert.equal(first.trades.length, 1);
  assert.equal(first.trades[0].amount, 1300000);
  assert.match(first.trades[0].reason, /미국 뉴스.*주문 규모 축소/);
  assert.equal(first.trades[0].realized, 0);
  assert.equal(first.news.from, previousClose);
  assert.equal(first.news.until, mondayAt("09:00"));
  assert.equal(first.news.count, 2);
  assert.equal(first.news.stance, "cautious");
  assert.match(openingExitReason(first.news, { name: "ETF 예시", type: "ETF" }, 9800, 10000), /시장 부담/);
  assert.equal(openingExitReason(first.news, { name: "ETF 예시", type: "ETF" }, 9900, 10000), null);
  assert.equal(newsRequests, first.news.feedCount);
  assert.equal((await runSlot(env)).status, "duplicate");
  assert.ok(called.mock.callCount() > 10);

  t.mock.timers.setTime(mondayAt("11:02"));
  outcome = 10600;
  const sale = await runSlot(env);
  assert.equal(sale.status, "ok");
  assert.equal(sale.trades.length, 1);
  assert.equal(sale.trades[0].realized, 78000);
  assert.equal(newsRequests, first.news.feedCount);
  const saved = await (await api("/api/state")).json();
  assert.equal(saved.trades.length, 2);
  assert.equal(saved.positions.length, 0);
  assert.equal(saved.totals.total, 10078000);
  assert.equal(saved.history.length, 2);
  assert.deepEqual(saved.openingNews, first.news);
  assert.deepEqual(saved.scans[0].news, first.news);
  assert.equal((await api("/api/disconnect", {})).status, 200);
  assert.equal((await (await api("/api/state")).json()).connected, false);
  assert.equal((await (await api("/api/state")).json()).trades.length, 2);
});

test("the server batch starts at the next exact hour without any browser request", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at("10:00") - 7000 });
  const runs = [];
  const stop = startBatch(async now => {
    runs.push(now);
    return { status: "ok", message: "done" };
  }, () => {});
  t.after(stop);
  assert.deepEqual(runs, []);
  t.mock.timers.tick(6999);
  assert.deepEqual(runs, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(runs, [at("10:00")]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(runs, [at("10:00")]);
});

test("opening batch waits for the first minutes of trading and stays neutral if news feeds fail", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at("09:02") });
  const runs = [];
  const stop = startBatch(async now => {
    runs.push(now);
    return { status: "ok", message: "done" };
  }, () => {});
  t.after(stop);
  assert.deepEqual(runs, []);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.deepEqual(runs, [at("09:03")]);

  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  const news = await collectOpeningNews({}, { date: "2026-11-25" });
  assert.equal(news.available, 0);
  assert.equal(news.stance, "neutral");
  assert.deepEqual(openingSignal(news, { name: "삼성전자", type: "주식" }),
    { score: 0, caution: false, reason: null, relevant: false });
});
