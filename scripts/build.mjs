import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await Promise.all([mkdir("dist/server", { recursive: true }), mkdir("dist/.openai", { recursive: true })]);
const resources = {
  "/": ["text/html; charset=utf-8", "index.html"],
  "/app.js": ["text/javascript; charset=utf-8", "app.js"],
  "/patterns.js": ["text/javascript; charset=utf-8", "patterns.js"],
  "/trade-chart.js": ["text/javascript; charset=utf-8", "trade-chart.js"],
  "/trade-chart-layout.mjs": ["text/javascript; charset=utf-8", "trade-chart-layout.mjs"],
  "/pattern-engine.mjs": ["text/javascript; charset=utf-8", "../server/chart-patterns.mjs"],
  "/app.css": ["text/css; charset=utf-8", "app.css"],
  "/mark.svg": ["image/svg+xml", "mark.svg"],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(resources).map(async ([route, [type, name]]) =>
  [route, [type, await readFile("web/" + name, "utf8")]])));
// Concurrent test workers and a local preview may build together on Windows.
// Replace whole files atomically so imports cannot read a partially copied module.
async function emit(path, content) {
  const bytes = Buffer.from(content);
  try { if ((await readFile(path)).equals(bytes)) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, bytes); await rename(temporary, path); }
  finally { try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
const copy = async (source, destination) => emit(destination, await readFile(source));
await Promise.all([
  emit("dist/server/assets.mjs", "export const assets = " + JSON.stringify(assets) + ";\n"),
  copy("server/main.mjs", "dist/server/index.js"),
  copy("server/engine.mjs", "dist/server/engine.mjs"),
  copy("server/toss.mjs", "dist/server/toss.mjs"),
  copy("server/us-news.mjs", "dist/server/us-news.mjs"),
  copy("server/us-engine.mjs", "dist/server/us-engine.mjs"),
  copy("server/us-paper.mjs", "dist/server/us-paper.mjs"),
  copy("server/paper-model.mjs", "dist/server/paper-model.mjs"),
  copy("server/paper-analytics.mjs", "dist/server/paper-analytics.mjs"),
  copy("server/market-transport.mjs", "dist/server/market-transport.mjs"),
  copy("server/market-events.mjs", "dist/server/market-events.mjs"),
  copy("server/daily-review.mjs", "dist/server/daily-review.mjs"),
  copy("server/closing-audit.mjs", "dist/server/closing-audit.mjs"),
  copy("server/chart-patterns.mjs", "dist/server/chart-patterns.mjs"),
  copy("server/trade-chart.mjs", "dist/server/trade-chart.mjs"),
  copy("server/strategy-policy.mjs", "dist/server/strategy-policy.mjs"),
  copy(".openai/hosting.json", "dist/.openai/hosting.json"),
]);
