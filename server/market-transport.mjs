// Active paper app transport only. No real order/modify/cancel endpoint is allowed.
const ORIGIN = "https://openapi.tossinvest.com";
export function rateGroup(path) {
  const p = path.split("?")[0].replace(/^\/api\/v1\//, "");
  if (path === "/oauth2/token") return "AUTH";
  if (p === "stocks/all") return "STOCK_ALL";
  if (p === "accounts") return "ACCOUNT";
  if (p === "holdings") return "ASSET";
  if (p === "candles") return "MARKET_DATA_CHART";
  if (["prices", "orderbook", "trades", "price-limits"].includes(p)) return "MARKET_DATA";
  if (p.startsWith("market-calendar/") || p === "exchange-rate") return "MARKET_INFO";
  if (p.startsWith("rankings")) return "RANKING";
  if (p === "market-indicators/prices") return "MARKET_INDICATOR_PRICE";
  if (/^market-indicators\/.+\/candles$/.test(p)) return "MARKET_INDICATOR_CHART";
  if (p.startsWith("market-indicators/")) return "MARKET_INDICATOR";
  if (/^stocks\/.+\/(investor-trading|program-trades|short-selling|credit-trades|securities-lending)$/.test(p)) return "STOCK_TRADING_TREND";
  if (p.startsWith("stocks")) return "STOCK";
  if (p === "sectors/rankings") return "SECTOR_RANKING";
  if (p.startsWith("sectors")) return "SECTOR";
  return "OTHER";
}
const limits = { AUTH: 5, ACCOUNT: 1, ASSET: 5, STOCK: 5, STOCK_ALL: 1, STOCK_TRADING_TREND: 10,
  MARKET_INFO: 3, MARKET_DATA: 15, MARKET_DATA_CHART: 20, RANKING: 5, MARKET_INDICATOR_PRICE: 10,
  MARKET_INDICATOR: 10, MARKET_INDICATOR_CHART: 5, SECTOR: 5, SECTOR_RANKING: 5, OTHER: 1 };
export class MarketTransportError extends Error {
  constructor(status, group, endpoint, retryAfter = null) {
    super("Market API request failed"); this.status = status; this.group = group;
    this.endpoint = endpoint.split("?")[0]; this.retryAfter = retryAfter;
  }
}
export function createMarketTransport({ fetchImpl = (...args) => fetch(...args), now = () => performance.now(), wallNow = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, maxWaitMs = 15000 } = {}) {
  const groups = new Map(), cache = new Map(), inFlight = new Map();
  const stats = { sent: 0, cacheHits: 0, shared: 0, rateLimited: 0, retries: 0, lastLimited: null };
  const seconds = value => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function lane(group) {
    if (!groups.has(group)) groups.set(group, { tail: Promise.resolve(), next: 0, limit: limits[group], gap: Math.ceil(1100 / limits[group]) });
    return groups.get(group);
  }
  function lifetime(path) {
    const p = path.split("?")[0];
    if (p.endsWith("/stocks/all")) return 6 * 3600000;
    if (p.includes("market-calendar/")) return 5 * 60000;
    if (p.endsWith("/warnings")) return 15000;
    if (p.endsWith("/rankings")) return 3000;
    if (p.endsWith("/orderbook")) return 100;
    return 250;
  }
  async function request(path, options = {}) {
    const method = options.method ?? "GET", group = rateGroup(path);
    if ((method !== "GET" && !(method === "POST" && path === "/oauth2/token")) || /^\/api\/v1\/(?:conditional-)?orders(?:[/?]|$)/.test(path)) {
      throw new Error("모의 앱에서는 실제 주문 API를 호출할 수 없습니다.");
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error("지원하지 않는 API 주소입니다.");
    url.searchParams.sort();
    const authorization = new Headers(options.headers).get("authorization") ?? "";
    // Credentials are never written to logs, status or disk; token identity only separates RAM caches.
    const key = authorization + "\n" + url.pathname + url.search;
    const ttl = method === "GET" ? lifetime(path) : 0;
    const cached = cache.get(key), wall = wallNow();
    if (ttl && cached && now() - cached.time < ttl && wall - cached.wall >= 0 && wall - cached.wall < ttl) {
      stats.cacheHits++; return structuredClone(cached.data);
    }
    if (ttl && inFlight.has(key)) { stats.shared++; return structuredClone(await inFlight.get(key)); }
    const state = lane(group);
    const deadline = now() + maxWaitMs;
    const perform = async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = Math.max(0, state.next - now());
        if (now() + wait > deadline) throw new MarketTransportError(429, group, path, Math.ceil(wait / 1000));
        if (wait) await sleep(wait);
        const sentAt = now();
        state.next = sentAt + state.gap;
        stats.sent++;
        let response;
        try { response = await fetchImpl(url, { ...options, method, redirect: "error", signal: AbortSignal.timeout(6500) }); }
        catch { throw new Error("토스증권 API에 연결할 수 없습니다."); }
        const limit = seconds(response.headers.get("x-ratelimit-limit"));
        if (limit && limit >= 1) { state.limit = Math.min(limits[group], limit); state.gap = Math.ceil(1100 / state.limit); }
        state.next = Math.max(state.next, sentAt + state.gap);
        const remaining = seconds(response.headers.get("x-ratelimit-remaining"));
        const reset = seconds(response.headers.get("x-ratelimit-reset"));
        if (remaining === 0 && reset !== null) state.next = Math.max(state.next, now() + reset * 1000 + 100);
        if (response.status === 429) {
          const retry = seconds(response.headers.get("retry-after"));
          const delay = Math.max((retry ?? 0) * 1000, (reset ?? 0) * 1000, 1000 * 2 ** attempt) + 100 + Math.floor(random() * 150);
          state.next = Math.max(state.next, now() + delay);
          stats.rateLimited++; stats.lastLimited = { group, endpoint: url.pathname, time: wallNow(), retryAfter: Math.ceil(delay / 1000) };
          await response.arrayBuffer();
          // GETs alone can retry. A token issuance or any real order is never blindly repeated.
          if (method !== "GET" || attempt >= 2 || state.next > deadline) throw new MarketTransportError(429, group, path, Math.ceil((state.next - now()) / 1000));
          stats.retries++; continue;
        }
        if (!response.ok) { await response.arrayBuffer(); throw new MarketTransportError(response.status, group, path); }
        let data;
        try { data = await response.json(); } catch { throw new Error("토스증권 응답을 읽을 수 없습니다."); }
        if (ttl) {
          if (cache.size > 400) for (const [k, entry] of cache) if (now() - entry.time > entry.ttl || wallNow() - entry.wall > entry.ttl || wallNow() < entry.wall) cache.delete(k);
          cache.set(key, { data: structuredClone(data), time: now(), wall: wallNow(), ttl });
        }
        return data;
      }
    };
    const task = state.tail.then(perform);
    state.tail = task.catch(() => {});
    if (ttl) inFlight.set(key, task);
    try { return structuredClone(await task); } finally { if (ttl && inFlight.get(key) === task) inFlight.delete(key); }
  }
  return { request, status() { return { ...stats, groups: Object.fromEntries([...groups].map(([group, state]) => [group,
    { limit: state.limit, minimumGapMs: state.gap, waitMs: Math.max(0, Math.ceil(state.next - now())) }])) }; } };
}
export const marketTransport = createMarketTransport();
