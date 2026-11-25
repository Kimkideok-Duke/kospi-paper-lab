import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarketTransport, rateGroup } from "../server/market-transport.mjs";

function fixture(respond, extra = {}) {
  let time = 0;
  const calls = [];
  const transport = createMarketTransport({ now: () => time, wallNow: () => time, sleep: async ms => { time += ms; }, random: () => 0,
    fetchImpl: async (url, options) => { calls.push({ time, path: url.pathname, search: url.search, method: options.method }); return respond(url, options, calls.length); }, ...extra });
  return { transport, calls, advance: ms => { time += ms; } };
}
const ok = (data = [], headers = {}) => Response.json({ result: data }, { headers });
test("stock master calls share a single FIFO lane and obey the one-per-second limit", async () => {
  const f = fixture(() => ok([], { "X-RateLimit-Limit": "1", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1" }));
  await Promise.all(["NASDAQ", "NYSE", "AMEX"].map(market => f.transport.request("/api/v1/stocks/all?market=" + market)));
  assert.equal(f.calls.length, 3); assert.deepEqual(f.calls.map(c => c.time), [0, 1100, 2200]);
  assert.equal(f.transport.status().groups.STOCK_ALL.limit, 1);
});
test("all active categories, authentication and unknown reads are rate-classified", () => {
  const cases = { "/oauth2/token": "AUTH", "/api/v1/accounts": "ACCOUNT", "/api/v1/holdings": "ASSET",
    "/api/v1/stocks/all?market=NYSE": "STOCK_ALL", "/api/v1/stocks/AAPL/warnings": "STOCK",
    "/api/v1/stocks/005930/investor-trading": "STOCK_TRADING_TREND", "/api/v1/candles": "MARKET_DATA_CHART",
    "/api/v1/prices": "MARKET_DATA", "/api/v1/orderbook": "MARKET_DATA", "/api/v1/price-limits": "MARKET_DATA",
    "/api/v1/trades": "MARKET_DATA", "/api/v1/market-calendar/US": "MARKET_INFO", "/api/v1/exchange-rate": "MARKET_INFO",
    "/api/v1/rankings": "RANKING", "/api/v1/market-indicators/prices": "MARKET_INDICATOR_PRICE",
    "/api/v1/market-indicators/KOSPI/candles": "MARKET_INDICATOR_CHART", "/api/v1/market-indicators/KOSPI/investor-trading": "MARKET_INDICATOR",
    "/api/v1/sectors/rankings": "SECTOR_RANKING", "/api/v1/sectors/one": "SECTOR", "/api/v1/new-resource": "OTHER" };
  for (const [path, group] of Object.entries(cases)) assert.equal(rateGroup(path), group);
});
test("response headers can lower the allowed rate and exhausted capacity waits for refill", async () => {
  const f = fixture(() => ok([], { "X-RateLimit-Limit": "1" }));
  await Promise.all(["AAPL", "SPY", "QQQ"].map(symbol => f.transport.request("/api/v1/prices?symbols=" + symbol)));
  assert.deepEqual(f.calls.map(c => c.time), [0, 1100, 2200]);
  const refill = fixture(() => ok([], { "X-RateLimit-Limit": "15", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1.5" }));
  await refill.transport.request("/api/v1/prices?symbols=AAPL"); await refill.transport.request("/api/v1/prices?symbols=SPY");
  assert.ok(refill.calls[1].time >= 1600);
});
test("429 read retries respect Retry-After and update a cooldown shared with subsequent callers", async () => {
  const f = fixture((url, options, count) => count === 1 ? Response.json({}, { status: 429, headers: { "Retry-After": "2", "X-RateLimit-Reset": "1" } }) : ok([1]));
  assert.deepEqual(await f.transport.request("/api/v1/prices?symbols=AAPL"), { result: [1] });
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].time >= 2100); assert.equal(f.transport.status().retries, 1);
  const blocked = fixture(() => Response.json({}, { status: 429, headers: { "Retry-After": "60" } }), { maxWaitMs: 1000 });
  await assert.rejects(blocked.transport.request("/api/v1/prices?symbols=AAPL"), e => e.status === 429 && e.retryAfter >= 60);
  await assert.rejects(blocked.transport.request("/api/v1/prices?symbols=SPY"), e => e.status === 429);
  assert.equal(blocked.calls.length, 1);
});
test("retries are bounded and token issuance is never blindly repeated", async () => {
  const f = fixture(() => Response.json({}, { status: 429, headers: { "Retry-After": "1" } }));
  await assert.rejects(f.transport.request("/api/v1/prices?symbols=AAPL"), e => e.status === 429);
  assert.equal(f.calls.length, 3);
  const auth = fixture(() => Response.json({}, { status: 429, headers: { "Retry-After": "1" } }));
  await assert.rejects(auth.transport.request("/oauth2/token", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials" }) }), e => e.status === 429);
  assert.equal(auth.calls.length, 1);
});
test("identical reads are coalesced, cache results are isolated, and expired prices refresh", async () => {
  const f = fixture(() => ok([{ symbol: "AAPL", price: 100 }]));
  const a = f.transport.request("/api/v1/prices?symbols=AAPL", { headers: { authorization: "Bearer private-a" } });
  const b = f.transport.request("/api/v1/prices?symbols=AAPL", { headers: { authorization: "Bearer private-a" } });
  const [x, y] = await Promise.all([a, b]); x.result[0].price = 0;
  assert.equal(y.result[0].price, 100); assert.equal(f.calls.length, 1); assert.equal(f.transport.status().shared, 1);
  await f.transport.request("/api/v1/prices?symbols=AAPL", { headers: { authorization: "Bearer private-a" } }); assert.equal(f.calls.length, 1);
  f.advance(300);
  await f.transport.request("/api/v1/prices?symbols=AAPL", { headers: { authorization: "Bearer private-a" } }); assert.equal(f.calls.length, 2);
  await f.transport.request("/api/v1/prices?symbols=AAPL", { headers: { authorization: "Bearer private-b" } }); assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(f.transport.status()).includes("private-"));
});
test("the paper transport cannot send orders or follow a different API origin", async () => {
  const f = fixture(() => ok());
  await assert.rejects(f.transport.request("/api/v1/orders", { method: "POST" }));
  await assert.rejects(f.transport.request("/api/v1/orders/one/cancel", { method: "POST" }));
  await assert.rejects(f.transport.request("https://other.example/api/v1/prices"));
  assert.equal(f.calls.length, 0);
});
