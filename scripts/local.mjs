import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalHost } from "../server/local-host.mjs";
import { startBatch } from "../server/batch.mjs";
import { startUsBatch } from "../server/us-batch.mjs";
import { startMonitorBatch, monitorStatus, MONITOR_INTERVAL_MS } from "../server/monitor-batch.mjs";
import "./build.mjs";

const { default: app, runSlot, runUsSlot, runMonitor } = await import("../dist/server/index.js");
const root = process.env.MARKETLAB_DATA ?? resolve(process.env.LOCALAPPDATA ?? homedir(), "MarketLab");
const port = Number(process.env.MARKETLAB_PORT ?? 8765);
const origin = "http://127.0.0.1:" + port;
const withSchedule = !process.argv.includes("--preview");
// Prefer the same address family as the public IP shown for Toss's allowlist.
setDefaultResultOrder("ipv4first");
mkdirSync(root, { recursive: true, mode: 0o700 });
const keyFile = resolve(root, "key");
try {
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const db = new DatabaseSync(resolve(root, "campaign.sqlite"));
db.exec(readFileSync(new URL("../drizzle/0000_campaign.sql", import.meta.url), "utf8")
  .replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
db.exec(readFileSync(new URL("../drizzle/0001_us_campaign.sql", import.meta.url), "utf8"));
const DB = {
  prepare(sql) {
    const statement = db.prepare(sql);
    const bind = (...parameters) => ({
      first: async () => statement.get(...parameters) ?? null,
      run: async () => ({ meta: { changes: statement.run(...parameters).changes } }),
    });
    return { ...bind(), bind };
  },
};
async function connectionIp() {
  const response = await fetch("https://api.ipify.org?format=json", {
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Public IP lookup failed");
  const { ip } = await response.json();
  if (typeof ip !== "string" || !isIPv4(ip)) throw new Error("Invalid public IPv4");
  return ip;
}

const runtime = { startedAt: Date.now(), lastMonitorTick: null, monitorIntervalMs: MONITOR_INTERVAL_MS };
const env = { DB, MARKETLAB_KEY: readFileSync(keyFile, "utf8"), MARKETLAB_BATCH: withSchedule, connectionIp, runtimeStatus: () => ({ ...runtime }) };

const host = createLocalHost({ root, masterKey: readFileSync(keyFile, "utf8"), baseEnv: env, app });
await host.initialize();

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== "127.0.0.1:" + port) {
      res.writeHead(403).end("로컬 주소로 접속해 주세요.");
      return;
    }
    const headers = new Headers(req.headers);
    headers.delete("oai-authenticated-user-id");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 10_000) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await host.fetch(new Request(origin + req.url, { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.once("listening", () => {
  console.log("Market Lab → " + origin);
  if (withSchedule) {
    const stopBatch = startBatch(time => host.runAll(runSlot, time));
    server.once("close", stopBatch);
    const stopUsBatch = startUsBatch(time => host.runAll(runUsSlot, time));
    server.once("close", stopUsBatch);
    const stopMonitor = startMonitorBatch(time => host.runAll(async (userEnv, at) => monitorStatus(await runMonitor(userEnv, at)), time), time => { runtime.lastMonitorTick = time; });
    server.once("close", stopMonitor);
  }
});
server.listen(port, "127.0.0.1");
