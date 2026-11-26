import { INITIAL, LIMIT, START, END, account, initialState, kst, manualSlotFor, slotFor, slotTime, execute } from "./engine.mjs";
import { issue, loadPrices, marketClient, scan, TossError } from "./toss.mjs";
import { assets } from "./assets.mjs";
import { initialUsState, usAccount, usDate, usSlotFor, nextUsSlot, validFx, executeUs, usSlots } from "./us-engine.mjs";
import { loadUsPrices, scanUs } from "./us-paper.mjs";
import { upgradePaper, alertPaper, setPaperConfig, activeOrder, markPaper } from "./paper-model.mjs";
import { analyticsView, recordAnalytics } from "./paper-analytics.mjs";
import { syncDailyReviews, reviewCalendar, reviewSymbols, recordReviewEvidence, rememberSession } from "./daily-review.mjs";
import { activateDailyPolicy } from "./strategy-policy.mjs";
import { marketEvents, ingestEvents, eventExitReason, eventsView, EVENT_POLICY } from "./market-events.mjs";
import { marketTransport } from "./market-transport.mjs";

const encode = new TextEncoder();
const decode = new TextDecoder();
const MAX_BODY = 10_000;
const lease = 3 * 60_000;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const protect = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const json = (body, status = 200) => Response.json(body, { status, headers: { ...protect, "cache-control": "no-store" } });

async function keyFor(env) {
  if (!/^[0-9a-f]{64}$/i.test(env.MARKETLAB_KEY ?? "")) throw new RequestError(503, "서버의 API 키 암호화 설정이 필요합니다.");
  const raw = Uint8Array.from(env.MARKETLAB_KEY.match(/../g), group => parseInt(group, 16));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function seal(env, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode.encode(label) },
    await keyFor(env), encode.encode(JSON.stringify(value)));
  return b64(iv) + "." + b64(new Uint8Array(cipher));
}

async function openSecret(env, payload, label) {
  try {
    const [iv, cipher] = payload.split(".").map(unb64);
    const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encode.encode(label) }, await keyFor(env), cipher);
    return JSON.parse(decode.decode(value));
  } catch {
    throw new RequestError(503, "저장된 토스증권 연결 정보를 읽지 못했습니다. 설정에서 다시 연결해 주세요.");
  }
}

async function record(env) {
  return env.DB.prepare("SELECT * FROM campaign WHERE id = 1").first();
}

async function locked(env, work) {
  await env.DB.prepare("INSERT OR IGNORE INTO campaign(id,state) VALUES (1,?)")
    .bind(JSON.stringify(initialState())).run();
  const owner = crypto.randomUUID();
  const now = Date.now();
  const lockedRow = await env.DB.prepare("UPDATE campaign SET lock_owner=?,lock_until=? WHERE id=1 AND lock_until<=?")
    .bind(owner, now + lease, now).run();
  if (!lockedRow.meta.changes) throw new RequestError(409, "다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.");
  const write = async (state, secrets, token, release = true) => {
    const result = await env.DB.prepare("UPDATE campaign SET state=?,secrets=?,access_token=?,lock_owner=?,lock_until=? WHERE id=1 AND lock_owner=? AND lock_until>?")
      .bind(JSON.stringify(state), secrets, token, release ? null : owner, release ? 0 : now + lease, owner, Date.now()).run();
    if (!result.meta.changes) throw new RequestError(409, "요청 처리 시간이 초과되었습니다. 다음 실행에서 다시 확인합니다.");
  };
  try {
    return await work(await record(env), write, owner);
  } finally {
    await env.DB.prepare("UPDATE campaign SET lock_owner=NULL,lock_until=0 WHERE id=1 AND lock_owner=?").bind(owner).run();
  }
}

async function configure(env, id, secret) {
  await keyFor(env);
  return locked(env, async (row, write) => {
    const token = await issue({ id, secret });
    await marketClient(token.value).get("prices", { symbols: "005930" });
    const state = JSON.parse(row.state);
    state.lastError = null;
    await write(state, await seal(env, { id, secret }, "toss:keys"), await seal(env, token, "toss:token"));
    return { connected: true };
  });
}

async function runSlot(env, now = Date.now()) {
  const slot = slotFor(now);
  if (!slot || now < slotTime(slot)) return { status: "outside", message: "캠페인 기간의 배치 실행 구간이 아닙니다.", trades: [] };
  return runMarketCheck(env, slot);
}

async function runMarketCheck(env, slot) {
  if (!(await record(env))?.secrets) return { status: "waiting", message: "토스증권 API 연결을 기다리고 있습니다.", trades: [] };
  return locked(env, async (row, write) => {
    const state = JSON.parse(row.state);
    upgradePaper(state, "KR", Date.now());
    syncDailyReviews(state, "KR", Date.now(), {pastOnly:true});
    const previous = state.scans.find(item => (item.id === slot.id || (!slot.manual && slot.minute === 0 && item.id === slot.id.slice(0, -3))) && item.status !== "error");
    if (previous && slot.manual) {
      const tradeIds = new Set(previous.tradeIds ?? []);
      return { status: previous.status, message: previous.message, trades: state.trades.filter(trade => tradeIds.has(trade.id)) };
    }
    if (previous) {
      return { status: "duplicate", message: "이 시간의 실행은 이미 기록되어 있습니다.", trades: [] };
    }
    if (!row.secrets) return { status: "waiting", message: "토스증권 API 연결을 기다리고 있습니다.", trades: [] };
    let tokenPayload = row.access_token;
    const getToken = async (force = false) => {
      let token = !force && tokenPayload ? await openSecret(env, tokenPayload, "toss:token") : null;
      if (!token || token.expires - Date.now() <= 60_000) {
        token = await issue(await openSecret(env, row.secrets, "toss:keys"));
        tokenPayload = await seal(env, token, "toss:token");
        await write(state, row.secrets, tokenPayload, false);
      }
      return token.value;
    };
    try {
      let result;
      const draft = structuredClone(state);
      try {
        result = await scan(draft, slot, marketClient(await getToken(), { paced: true }), Date.now());
      } catch (error) {
        if (error.status !== 401) throw error;
        result = await scan(draft, slot, marketClient(await getToken(true), { paced: true }), Date.now());
      }
      syncDailyReviews(draft, slot.market === "US" ? "US" : "KR", Date.now());
      draft.lastError = null;
      draft.operations.lastAnalysis = Date.now();
      if (slot.event && draft.eventWatch?.pending?.id === slot.id.split(":").at(-1)) { draft.eventWatch.pending = null; draft.eventWatch.lastEventAnalysis = Date.now(); }
      draft.scans = draft.scans.filter(item => item.id !== slot.id);
      draft.scans.push({ id: slot.id, time: Date.now(), status: result.status,
        message: result.message, tradeCount: result.trades?.length ?? 0,
        ...(slot.manual ? { source: slot.event ? "event" : "manual", tradeIds: result.trades?.map(trade => trade.id) ?? [] } : {}),
        ...(result.news ? { news: result.news } : {}) });
      await write(draft, row.secrets, tokenPayload);
      return { ...result, trades: result.trades ?? [] };
    } catch (error) {
      const message = error.message || "시장 분석을 마치지 못했습니다.";
      alertPaper(state, "analysis-error", message, Date.now(), "error");
      state.lastError = { time: Date.now(), message, ...(error.group ? { group: error.group, endpoint: error.endpoint, retryAfter: error.retryAfter } : {}) };
      state.scans = state.scans.filter(item => item.id !== slot.id);
      state.scans.push({ id: slot.id, time: Date.now(), status: "error", message, tradeCount: 0,
        ...(slot.manual ? { source: slot.event ? "event" : "manual" } : {}) });
      await write(state, row.secrets, tokenPayload);
      return { status: "error", message, trades: [] };
    }
  });
}

function nextSlot(now) {
  const minimum = Date.parse(START + "T09:00:00+09:00");
  let attempt = Math.max(Math.floor(now / 600_000) * 600_000, minimum);
  while (kst(attempt).slice(0, 10) < END) {
    const slot = slotFor(attempt);
    if (slot && slotTime(slot) > now) return slotTime(slot);
    attempt += 600_000;
  }
  return null;
}

async function usRecord(env) {
  return env.DB.prepare("SELECT * FROM us_campaign WHERE id=1").first();
}

async function runUsSlot(env, now = Date.now(), requestId = null, eventId = null) {
  if (usDate(now) < START || usDate(now) >= END) return { status: "outside", message: "미국장 모의투자 기간이 아닙니다.", trades: [] };
  if (!(await record(env))?.secrets) return { status: "waiting", message: "공유 토스증권 API 연결을 기다리고 있습니다.", trades: [] };
  return locked(env, async (credentials, writeCredentials, owner) => {
    const domestic = JSON.parse(credentials.state);
    const row = await usRecord(env);
    const state = row ? JSON.parse(row.state) : initialUsState();
    upgradePaper(state, "US", Date.now());
    syncDailyReviews(state, "US", Date.now(), {pastOnly:true});
    let tokenPayload = credentials.access_token;
    const writeUs = async value => {
      await env.DB.prepare("INSERT OR IGNORE INTO us_campaign(id,state) VALUES(1,?)").bind(JSON.stringify(initialUsState())).run();
      const result = await env.DB.prepare("UPDATE us_campaign SET state=? WHERE id=1 AND EXISTS (SELECT 1 FROM campaign WHERE id=1 AND lock_owner=? AND lock_until>?)")
        .bind(JSON.stringify(value), owner, Date.now()).run();
      if (!result.meta.changes) throw new RequestError(409, "미국장 분석 시간이 초과되어 저장하지 않았습니다.");
    };
    const getToken = async (force = false) => {
      let token = !force && tokenPayload ? await openSecret(env, tokenPayload, "toss:token") : null;
      if (!token || token.expires - Date.now() <= 60_000) {
        token = await issue(await openSecret(env, credentials.secrets, "toss:keys"));
        tokenPayload = await seal(env, token, "toss:token");
        await writeCredentials(domestic, credentials.secrets, tokenPayload, false);
      }
      return token.value;
    };
    let slot;
    try {
      if (state.calendar?.date !== usDate(now)) {
        let calendar;
        try { calendar = await marketClient(await getToken()).get("market-calendar/US", { date: usDate(now) }); }
        catch (error) {
          if (error.status !== 401) throw error;
          calendar = await marketClient(await getToken(true)).get("market-calendar/US", { date: usDate(now) });
        }
        if (calendar?.today?.date !== usDate(now)) throw new Error("미국 현지 거래일의 장 운영 일정을 확인하지 못했습니다.");
        state.calendar = { date: usDate(now), result: calendar };
        state.lastError = null;
        await writeUs(state);
      }
      const calendar = state.calendar.result;
      slot = usSlotFor(calendar, now, requestId);
      if (slot && eventId) slot = { ...slot, id: "us:event:" + eventId, event: true };
      if (!slot) return { status: "outside", message: "미국 정규장 분석 구간이 아닙니다.", trades: [] };
      const previous = state.scans.find(log => log.id === slot.id && log.status !== "error");
      if (previous) {
        const ids = new Set(previous.tradeIds ?? []);
        return requestId ? { status: previous.status, message: previous.message, trades: state.trades.filter(trade => ids.has(trade.id)) }
          : { status: "duplicate", message: "이 미국장 회차는 이미 기록되었습니다.", trades: [] };
      }
      let draft = structuredClone(state), result;
      try {
        result = await scanUs(draft, slot, marketClient(await getToken(), { paced: true }), calendar);
      } catch (error) {
        if (error.status !== 401) throw error;
        // Discard a partially mutated scan before retrying with a refreshed shared token.
        draft = structuredClone(state);
        result = await scanUs(draft, slot, marketClient(await getToken(true), { paced: true }), calendar);
      }
      syncDailyReviews(draft, slot.market === "US" ? "US" : "KR", Date.now());
      draft.lastError = null;
      draft.operations.lastAnalysis = Date.now();
      if (slot.event && draft.eventWatch?.pending?.id === slot.id.split(":").at(-1)) { draft.eventWatch.pending = null; draft.eventWatch.lastEventAnalysis = Date.now(); }
      draft.scans = draft.scans.filter(log => log.id !== slot.id);
      draft.scans.push({ id: slot.id, time: Date.now(), status: result.status, message: result.message,
        tradeCount: result.trades?.length ?? 0, ...(slot.manual ? { source: slot.event ? "event" : "manual", tradeIds: result.trades?.map(t => t.id) ?? [] } : {}),
        ...(result.news ? { news: result.news } : {}) });
      await writeUs(draft);
      await writeCredentials(domestic, credentials.secrets, tokenPayload);
      return { ...result, trades: result.trades ?? [] };
    } catch (error) {
      const message = error.message || "미국장 분석을 마치지 못했습니다.";
      alertPaper(state, "analysis-error", message, Date.now(), "error");
      const id = slot?.id ?? "us-calendar:" + usDate(now);
      state.lastError = { time: Date.now(), message, ...(error.group ? { group: error.group, endpoint: error.endpoint, retryAfter: error.retryAfter } : {}) };
      state.scans = state.scans.filter(log => log.id !== id);
      state.scans.push({ id, time: Date.now(), status: "error", message, tradeCount: 0 });
      await writeUs(state);
      await writeCredentials(domestic, credentials.secrets, tokenPayload);
      return { status: "error", message, trades: [] };
    }
  });
}

function usView(row, credentials, env) {
  const state = row ? JSON.parse(row.state) : initialUsState();
  const now = Date.now(), batchEnabled = env.MARKETLAB_BATCH === true;
  return { market: "US", currency: "USD", timezone: "America/New_York", start: START, end: END,
    now, next: batchEnabled ? nextUsSlot(state.calendar?.result, now) : null,
    session: state.calendar?.result?.today ?? null, nextSession: state.calendar?.result?.nextBusinessDay ?? null,
    batchEnabled, initial: INITIAL, limit: LIMIT, connected: Boolean(credentials?.secrets),
    canCheckIp: typeof env.connectionIp === "function", finished: usDate(now) >= END,
    totals: usAccount(state), positions: state.positions, trades: state.trades, history: state.history,
    analytics: analyticsView(state, "US"), eventWatch: eventsView(state, now), reviewCalendar: reviewCalendar(state,"US",now),
    scans: state.scans.slice(-100), openingNews: state.scans.findLast(log => log.news)?.news ?? null,
    latest: state.latest, lastError: state.lastError, fx: state.fx,
    fxMode: "거래 시점 매매기준율로 원화 정산", selection: "NASDAQ·NYSE·AMEX 거래대금 상위 100종목 중 주식·ETF" };
}

async function runMonitor(env, now = Date.now()) {
  const results = [], triggers = [];
  for (const market of ["KR", "US"]) {
    try {
      results.push(await locked(env, async (credentials, write, owner) => {
        const usRow = market === "US" ? await usRecord(env) : null;
        const state = market === "US" ? usRow ? JSON.parse(usRow.state) : initialUsState() : JSON.parse(credentials.state);
        upgradePaper(state, market, now);
        syncDailyReviews(state, market, now, {pastOnly:true});
        let tokenPayload = credentials.access_token;
        const persist = async value => {
          if (market === "US") {
            await env.DB.prepare("INSERT OR IGNORE INTO us_campaign(id,state) VALUES(1,?)").bind(JSON.stringify(initialUsState())).run();
            const result = await env.DB.prepare("UPDATE us_campaign SET state=? WHERE id=1 AND EXISTS (SELECT 1 FROM campaign WHERE id=1 AND lock_owner=? AND lock_until>?)")
              .bind(JSON.stringify(value), owner, Date.now()).run();
            if (!result.meta.changes) throw new RequestError(409, "감시 원장 저장 시간이 초과되었습니다.");
          }
          await write(market === "KR" ? value : JSON.parse(credentials.state), credentials.secrets, tokenPayload);
        };
        const draft = structuredClone(state);
        try {
          const date = market === "US" ? usDate(now) : kst(now).slice(0, 10);
          draft.operations.lastMonitor = now;
          if (!credentials.secrets || date < START || date >= END) {
            draft.operations.status = !credentials.secrets || date < START ? "waiting" : "finished";
            if (date >= START && date < END) recordAnalytics(draft, market, now);
            syncDailyReviews(draft,market,now);
            await persist(draft); return { status: "waiting" };
          }
          const getToken = async (force = false) => {
            let token = !force && tokenPayload ? await openSecret(env, tokenPayload, "toss:token") : null;
            if (!token || token.expires - Date.now() <= 60_000) {
              token = await issue(await openSecret(env, credentials.secrets, "toss:keys"));
              tokenPayload = await seal(env, token, "toss:token");
              await write(market === "KR" ? state : JSON.parse(credentials.state), credentials.secrets, tokenPayload, false);
            }
            return token.value;
          };
          let client;
          const reads = { missing: new Set(), async get(path, params = {}) {
            client ??= marketClient(await getToken(), { paced: true });
            try { return await client.get(path, params); } catch (error) {
              if (error.status !== 401) throw error;
              client = marketClient(await getToken(true), { paced: true }); return client.get(path, params);
            }
          } };
          if (draft.calendar?.date !== date) {
            const calendar = await reads.get("market-calendar/" + market, { date });
            if (calendar?.today?.date !== date) throw new Error("해당 거래일의 감시용 장 운영 일정을 확인하지 못했습니다.");
            if (calendar?.today?.date !== date) throw new Error("감시용 거래소 일정을 확인하지 못했습니다.");
            draft.calendar = { date, result: calendar };
          }
          rememberSession(draft, market);
          activateDailyPolicy(draft, market, now);
          const calendar = draft.calendar.result, regular = market === "US" ? calendar.today.regularMarket : calendar.today.integrated?.regularMarket;
          const start = Date.parse(regular?.startTime), end = Date.parse(market === "US" ? regular?.endTime : regular?.singlePriceAuctionStartTime ?? regular?.endTime);
          const open = now >= start && now < end;
          let expected = market === "US" ? usSlots(calendar.today) : [];
          if (market === "KR" && regular) {
            for (let time = Math.floor(start / 600_000) * 600_000; time < Math.min(now + 1, end); time += 600_000) {
              const slot = slotFor(time);
              if (slot) expected.push({ ...slot, time: slotTime(slot) });
            }
            const closing = Date.parse(date + "T16:00:00+09:00");
            expected.push({ id: date + "T16:00", time: closing });
          }
          for (const slot of expected.filter(s => s.time >= draft.paperModel.appliedAt && now >= s.time + 3 * 60_000)) {
            if (draft.scans.some(s => s.id === slot.id && s.status !== "error")) continue;
            const key = "missed:" + slot.id;
            if (!draft.alerts.some(a => a.key === key)) alertPaper(draft, key, "예정된 " + (market === "US" ? "미국장" : "국내장") + " 10분 분석이 완료되지 않았습니다.", now, "error");
          }
          if (!open) {
            const snapshot = await (env.collectEvents ?? ((m, options) => marketEvents.collect(m, options)))(market, { closed: true });
            ingestEvents(draft, snapshot, market, Date.now());
            for (const order of draft.paperOrders.filter(activeOrder)) { order.status = "EXPIRED"; order.note = "정규장 종료"; }
            const close = Date.parse(regular?.endTime);
            if (now >= close + 60000 && now < close + 15*60000 && draft.reviewCloseCapturedDate !== date) {
              const symbols = reviewSymbols(draft, market, now);
              const prices = market === "US" ? await loadUsPrices(reads, symbols) : await loadPrices(reads, symbols);
              const closing = new Map([...prices].filter(([,q]) => q.time >= start && q.time <= close && close-q.time <= 15*60000));
              const fx = market === "US" ? validFx(await reads.get("exchange-rate", {baseCurrency:"USD",quoteCurrency:"KRW"}),Date.now()) : {rate:1};
              markPaper(draft,market,closing,fx,Date.now());
              recordReviewEvidence(draft,market,closing,fx,Date.now());
              draft.reviewCloseQuality ??= {};
              draft.reviewCloseQuality[date]={checkedAt:Date.now(),missingSymbols:symbols.filter(symbol=>!closing.has(symbol)),pricedSymbols:closing.size};
              draft.reviewCloseCapturedDate=date;
            }
            draft.operations.status = "closed"; recordAnalytics(draft, market, now); syncDailyReviews(draft,market,Date.now()); await persist(draft); return { status: "outside" };
          }
          const snapshot = await (env.collectEvents ?? (m => marketEvents.collect(m)))(market);
          const freshEvents = ingestEvents(draft, snapshot, market, Date.now());
          for (const item of freshEvents) alertPaper(draft, "event:" + item.fingerprint, item.source + " · " + item.title, now, item.direction < 0 ? "warning" : "info");
          if (draft.eventWatch.sources.some(s => s.status !== "ok")) alertPaper(draft, "event-feed-error", "일부 뉴스·공시 피드를 확인하지 못했습니다. 장중 뉴스·공시 상태를 확인해 주세요.", now);
          const symbols = [...new Set([...draft.positions.map(p => p.symbol), ...reviewSymbols(draft, market, now), ...draft.paperOrders.filter(activeOrder).map(o => o.symbol), ...(market === "US" ? ["SPY", "QQQ"] : ["069500"])])];
          const quotes = market === "US" ? await loadUsPrices(reads, symbols) : await loadPrices(reads, symbols);
          const fx = market === "US" ? validFx(await reads.get("exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" }), Date.now()) : { rate: 1, from: now, until: Date.now() + 60000 };
          const books = new Map();
          const tradingSymbols = [...new Set([...draft.positions.map(p => p.symbol), ...draft.paperOrders.filter(activeOrder).map(o => o.symbol)])];
          for (const symbol of tradingSymbols) {
            books.set(symbol, await reads.get("orderbook", { symbol }));
            const q = quotes.get(symbol);
            if (!q || Date.now() - q.time > 90_000 || q.time < start) alertPaper(draft, "stale-quote:" + symbol, symbol + "의 최신 정규장 시세가 없어 체결을 보류했습니다.", now);
          }
          const finish = Date.now();
          markPaper(draft, market, quotes, fx, finish);
          const baselineEquity = market === "US" ? usAccount(draft).total : account(draft).total;
          const previous = draft.previous?.date === date ? (draft.previous.prices ?? draft.previous) : null;
          const openingExit = (position, price) => eventExitReason(draft, position, price, previous?.[position.symbol], finish, market);
          const trades = market === "US" ? executeUs(draft, { now: finish, slot: { date, regularStart: start, regularEnd: end }, quotes, fx, books, monitor: true, openingExit })
            : execute(draft, { now: finish, regularStart: start, regularEnd: end, quotes, books, candidates: [], monitor: true, openingExit });
          if (market === "US") draft.fx = fx;
          const benchmarks = (market === "US" ? ["SPY", "QQQ"] : ["069500"]).flatMap(symbol => {
            const q = quotes.get(symbol); return q && q.time >= start ? [{ symbol, name: symbol === "069500" ? "KODEX 200" : symbol, price: q.price, time: q.time, fx: fx.rate }] : [];
          });
          if (market === "KR") {
            const index = (await reads.get("market-indicators/prices", { symbols: "KOSPI" }))?.find(row => row.symbol === "KOSPI");
            if (index) benchmarks.push({ symbol: "KOSPI", name: "코스피", price: Number(index.lastPrice), time: Date.parse(index.timestamp), fx: 1 });
          }
          draft.operations.quoteFresh = tradingSymbols.every(symbol => {
            const q = quotes.get(symbol); return q && q.time >= start && q.time <= finish + 3000 && finish - q.time <= 90000;
          });
          draft.operations.status = draft.operations.quoteFresh ? "monitoring" : "stale";
          const validTimes = [...quotes.values()].filter(q => q.time >= start && q.time <= finish + 3000 && finish - q.time <= 90000).map(q => q.time);
          if (validTimes.length) draft.operations.lastQuote = Math.max(...validTimes);
          draft.history.push({ time: finish, total: market === "US" ? usAccount(draft).total : account(draft).total, source: "monitor" });
          recordAnalytics(draft, market, finish, benchmarks, baselineEquity);
          if (trades.length) {
            draft.scans.push({ id: "monitor:" + Math.floor(now / 60000), time: finish, source: "monitor", status: "ok", tradeCount: trades.length, message: "1분 보유 감시에서 " + trades.length + "건의 모의 체결을 기록했습니다." });
            alertPaper(draft, "protective-fill:" + Math.floor(now / 60000), "보유 종목 감시에서 " + trades.length + "건의 모의 체결이 발생했습니다.", finish, "info");
          }
          recordReviewEvidence(draft,market,quotes,fx,finish);
          syncDailyReviews(draft,market,finish);
          const pending = draft.eventWatch.pending;
          const ready = pending && finish - draft.eventWatch.lastAnalysisAttempt >= EVENT_POLICY.reanalysisMs;
          if (ready) draft.eventWatch.lastAnalysisAttempt = finish;
          await persist(draft);
          if (ready) triggers.push({ market, id: pending.id });
          return { status: "ok", trades };
        } catch (error) {
          state.operations.lastMonitor = now; state.operations.status = "error";
          state.operations.lastError = error.message;
          alertPaper(state, "monitor-error", "보유 감시/API 오류: " + error.message, now, "error");
          syncDailyReviews(state,market,Date.now());
          await persist(state); return { status: "error", message: error.message };
        }
      }));
    } catch (error) { if (error.status !== 409) throw error; }
  }
  for (const trigger of triggers) {
    try {
      if (trigger.market === "US") results.push(await runUsSlot(env, Date.now(), trigger.id, trigger.id));
      else { const slot = manualSlotFor(Date.now(), trigger.id); if (slot) results.push(await runMarketCheck(env, { ...slot, id: "kr:event:" + trigger.id, event: true })); }
    } catch (error) { if (error.status !== 409) console.error("뉴스 추가 분석 실패", error.status ?? "internal"); }
  }
  return results;
}

function view(row, env) {
  const state = row ? JSON.parse(row.state) : initialState();
  const batchEnabled = env.MARKETLAB_BATCH === true;
  const now = Date.now();
  const date = kst(now).slice(0, 10);
  let next = nextSlot(now);
  if (next && state.calendar?.date === date) {
    const nextBusinessDate = state.calendar.result?.nextBusinessDay?.date;
    const hasRegular = state.calendar.result?.today?.date === date && state.calendar.result.today.integrated?.regularMarket;
    if (nextBusinessDate && (!hasRegular || kst(next).slice(0, 10) !== date)) {
      next = nextBusinessDate < END ? slotTime({ id: nextBusinessDate + "T09", hour: 9 }) : null;
    }
  }
  return {
    start: START, end: END, now, next: batchEnabled ? next : null, batchEnabled, initial: INITIAL, limit: LIMIT,
    canCheckIp: typeof env.connectionIp === "function",
    connected: Boolean(row?.secrets), totals: account(state),
    positions: state.positions, trades: state.trades,
    history: state.history, scans: state.scans.slice(-100),
    openingNews: state.scans.findLast(item => item.news)?.news ?? null,
    latest: state.latest, lastError: state.lastError,
    analytics: analyticsView(state, "KR"), eventWatch: eventsView(state, now), reviewCalendar: reviewCalendar(state,"KR",now),
    finished: date >= END,
  };
}

function authenticate(request) {
  if (!request.headers.get("oai-authenticated-user-id")) throw new RequestError(401, "사이트 소유자 계정으로 로그인해 주세요.");
}

function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  if (origin !== url.origin && origin !== "https://kospi-paper-lab.kkd9013.chatgpt.site") {
    throw new RequestError(403, "이 사이트에서 요청해 주세요.");
  }
}

async function body(request, max = MAX_BODY) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    || Number(request.headers.get("content-length")) > max) throw new RequestError(400, "요청을 읽을 수 없습니다.");
  const value = await request.text();
  if (value.length > max) throw new RequestError(400, "요청이 너무 깁니다.");
  try {
    return JSON.parse(value);
  } catch {
    throw new RequestError(400, "요청을 읽을 수 없습니다.");
  }
}

function safeError(error) {
  if (error instanceof RequestError || error instanceof TossError) return error.message;
  return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

async function handler(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/")) {
    authenticate(request);
    if (["/api/reviews", "/api/us/reviews"].includes(pathname) && request.method === "GET") {
      const market = pathname.includes("/us/") ? "US" : "KR", row = market === "US" ? await usRecord(env) : await record(env);
      const state = row ? JSON.parse(row.state) : market === "US" ? initialUsState() : initialState();
      const date = new URL(request.url).searchParams.get("date");
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400,"날짜 형식을 확인해 주세요.");
      if (date) return json({ report: state.reviews?.[date] ?? null });
      return json(reviewCalendar(state,market,Date.now()));
    }
    if (pathname === "/api/health" && request.method === "GET") return json({ now: Date.now(), batchEnabled: env.MARKETLAB_BATCH === true, api: marketTransport.status(),
      ...(typeof env.runtimeStatus === "function" ? env.runtimeStatus() : { startedAt: null, lastMonitorTick: null }) });
    if (pathname === "/api/us/state" && request.method === "GET") return json(usView(await usRecord(env), await record(env), env));
    if (pathname === "/api/us/quotes" && request.method === "GET") {
      const paper = await usRecord(env), state = paper ? JSON.parse(paper.state) : initialUsState();
      return json({ source: "server-monitor", quotes: Object.fromEntries(state.positions.map(p => [p.symbol,
        { price: p.price, priceUsd: p.priceUsd, time: p.quoteTime, fxRate: p.fxRate }])) });
    }
    if (pathname === "/api/state" && request.method === "GET") return json(view(await record(env), env));
    if (pathname === "/api/connection-ip" && request.method === "GET") {
      if (typeof env.connectionIp !== "function") throw new RequestError(404, "로컬 마켓랩에서 송신 IP를 확인해 주세요.");
      try {
        return json({ ip: await env.connectionIp() });
      } catch {
        throw new RequestError(502, "서버의 공인 IPv4를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    }
    if (pathname === "/api/quotes" && request.method === "GET") {
      const row = await record(env);
      const state = row ? JSON.parse(row.state) : initialState();
      return json({ source: "server-monitor", quotes: Object.fromEntries(state.positions.map(p => [p.symbol, { price: p.price, time: p.quoteTime }])) });
    }
    if (request.method === "POST") {
      requireSameOrigin(request);
      if (["/api/model", "/api/us/model"].includes(pathname)) {
        const config = await body(request), market = pathname.includes("/us/") ? "US" : "KR";
        return json(await locked(env, async (credentials, write, owner) => {
          const row = market === "US" ? await usRecord(env) : credentials;
          const state = row ? JSON.parse(row.state) : market === "US" ? initialUsState() : initialState();
          try { setPaperConfig(state, market, Date.now(), config); } catch (error) { throw new RequestError(400, error.message); }
          if (market === "US") {
            await env.DB.prepare("INSERT OR IGNORE INTO us_campaign(id,state) VALUES(1,?)").bind(JSON.stringify(initialUsState())).run();
            const saved = await env.DB.prepare("UPDATE us_campaign SET state=? WHERE id=1 AND EXISTS(SELECT 1 FROM campaign WHERE lock_owner=? AND lock_until>?)")
              .bind(JSON.stringify(state), owner, Date.now()).run();
            if (!saved.meta.changes) throw new RequestError(409, "설정 저장 잠금 시간이 초과되었습니다.");
          } else await write(state, credentials.secrets, credentials.access_token);
          return { version: state.paperModel.version, config: state.paperModel.config };
        }));
      }
      if (pathname === "/api/us/manual-run") {
        const { requestId } = (await body(request)) ?? {};
        if (typeof requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) throw new RequestError(400, "미국장 모의 실행 요청을 읽을 수 없습니다.");
        return json(await runUsSlot(env, Date.now(), requestId.toLowerCase()));
      }
      if (pathname === "/api/manual-run") {
        const { requestId } = (await body(request)) ?? {};
        if (typeof requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) {
          throw new RequestError(400, "거래 실행 요청을 읽을 수 없습니다.");
        }
        const slot = manualSlotFor(Date.now(), requestId.toLowerCase());
        return json(slot ? await runMarketCheck(env, slot) : {
          status: "outside", message: "모의투자 기간의 거래일 정규장 연속매매 시간에 실행할 수 있습니다.", trades: [],
        });
      }
      if (pathname === "/api/connect") {
        const { id, secret } = (await body(request)) ?? {};
        if (typeof id !== "string" || typeof secret !== "string" || !id.trim() || !secret.trim()
          || id.length > 512 || secret.length > 512) throw new RequestError(400, "Client ID와 Client Secret을 입력해 주세요.");
        return json(await configure(env, id.trim(), secret.trim()));
      }
      if (pathname === "/api/disconnect") {
        return json(await locked(env, async (row, write) => {
          const state = JSON.parse(row.state);
          state.lastError = null;
          await write(state, null, null);
          return { connected: false };
        }));
      }
    }
    return json({ error: "페이지를 찾을 수 없습니다." }, 404);
  }
  if (request.method === "GET" && Object.hasOwn(assets, pathname)) {
    const [type, content] = assets[pathname];
    return new Response(content, { headers: { ...protect, "content-type": type,
      "cache-control": pathname === "/" ? "no-store" : "public, max-age=300" } });
  }
  if (request.method === "GET" && ["/trades", "/settings", "/us", "/us/trades", "/reviews", "/us/reviews"].includes(pathname)) {
    return new Response(assets["/"][1], { headers: { ...protect, "content-type": assets["/"][0], "cache-control": "no-store" } });
  }
  return new Response("페이지를 찾을 수 없습니다.", { status: 404, headers: protect });
}

export default {
  async fetch(request, env) {
    try {
      return await handler(request, env);
    } catch (error) {
      if (!error.status) console.error(error);
      return json({ error: safeError(error) }, error instanceof RequestError ? error.status : error.status ? 502 : 500);
    }
  },
};
export { runSlot, runUsSlot, runMonitor };
