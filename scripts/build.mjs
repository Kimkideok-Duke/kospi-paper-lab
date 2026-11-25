import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await Promise.all([mkdir("dist/server", { recursive: true }), mkdir("dist/.openai", { recursive: true })]);
const resources = {
  "/": ["text/html; charset=utf-8", "index.html"],
  "/app.js": ["text/javascript; charset=utf-8", "app.js"],
  "/app.css": ["text/css; charset=utf-8", "app.css"],
  "/mark.svg": ["image/svg+xml", "mark.svg"],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(resources).map(async ([route, [type, name]]) =>
  [route, [type, await readFile("web/" + name, "utf8")]])));
await Promise.all([
  writeFile("dist/server/assets.mjs", "export const assets = " + JSON.stringify(assets) + ";\n"),
  copyFile("server/main.mjs", "dist/server/index.js"),
  copyFile("server/engine.mjs", "dist/server/engine.mjs"),
  copyFile("server/toss.mjs", "dist/server/toss.mjs"),
  copyFile(".openai/hosting.json", "dist/.openai/hosting.json"),
]);
