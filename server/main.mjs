import { INITIAL, LIMIT, START, END, account, initialState, kst, slotFor } from "./engine.mjs";
import { issue, loadPrices, marketClient, scan, TossError } from "./toss.mjs";
import { assets } from "./assets.mjs";

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
    return await work(await record(env), write);
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
  if (!slot) return { status: "outside", message: "캠페인 기간의 정시 실행 구간이 아닙니다.", trades: [] };
  if (!(await record(env))?.secrets) return { status: "waiting", message: "토스증권 API 연결을 기다리고 있습니다.", trades: [] };
  return locked(env, async (row, write) => {
    const state = JSON.parse(row.state);
    if (state.scans.some(item => item.id === slot.id && item.status !== "error")) {
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
        result = await scan(draft, slot, marketClient(await getToken()), Date.now());
      } catch (error) {
        if (error.status !== 401) throw error;
        result = await scan(draft, slot, marketClient(await getToken(true)), Date.now());
      }
      draft.lastError = null;
      draft.scans = draft.scans.filter(item => item.id !== slot.id);
      draft.scans.push({ id: slot.id, time: Date.now(), status: result.status,
        message: result.message, tradeCount: result.trades?.length ?? 0 });
      await write(draft, row.secrets, tokenPayload);
      return { ...result, trades: result.trades ?? [] };
    } catch (error) {
      const message = error.message || "자동 분석을 마치지 못했습니다.";
      state.lastError = { time: Date.now(), message };
      state.scans = state.scans.filter(item => item.id !== slot.id);
      state.scans.push({ id: slot.id, time: Date.now(), status: "error", message, tradeCount: 0 });
      await write(state, row.secrets, tokenPayload);
      return { status: "error", message, trades: [] };
    }
  });
}

function nextSlot(now) {
  const minimum = Date.parse(START + "T09:00:00+09:00");
  let attempt = Math.max(Math.floor(now / 3600_000) * 3600_000 + 3600_000, minimum);
  while (kst(attempt).slice(0, 10) < END) {
    if (slotFor(attempt)) return attempt;
    attempt += 3600_000;
  }
  return null;
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
      next = nextBusinessDate < END ? Date.parse(nextBusinessDate + "T09:00:00+09:00") : null;
    }
  }
  return {
    start: START, end: END, now, next: batchEnabled ? next : null, batchEnabled, initial: INITIAL, limit: LIMIT,
    canCheckIp: typeof env.connectionIp === "function",
    connected: Boolean(row?.secrets), totals: account(state),
    positions: state.positions, trades: state.trades,
    history: state.history, scans: state.scans.slice(-100),
    latest: state.latest, lastError: state.lastError,
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
    throw new RequestError(403, "이 사이트에서 설정을 제출해 주세요.");
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
      const data = view(row, env);
      if (data.finished || !row?.access_token || !data.positions.length) return json({ quotes: {} });
      const slot = slotFor(Math.floor(Date.now() / 3600_000) * 3600_000);
      if (!slot || slot.review) return json({ quotes: {} });
      const token = await openSecret(env, row.access_token, "toss:token");
      if (Date.now() >= token.expires) return json({ quotes: {} });
      return json({ quotes: Object.fromEntries(await loadPrices(marketClient(token.value), data.positions.map(item => item.symbol))) });
    }
    if (request.method === "POST") {
      requireSameOrigin(request);
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
  if (request.method === "GET" && ["/trades", "/settings"].includes(pathname)) {
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
export { runSlot };
