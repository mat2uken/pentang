#!/usr/bin/env node
// cdp-eval — Android WebView (debuggable) へCDPでJS評価する小物。
// usage: node scripts/cdp-eval.mjs --port 9222 --expr "<js>" [--timeout 30000]
import { parseKVArgs } from "./lib.mjs";

const { kv } = parseKVArgs(process.argv.slice(2));
const port = Number(kv["port"] ?? "9222");
const expr = kv["expr"];
const timeoutMs = Number(kv["timeout"] ?? "30000");
if (typeof expr !== "string" || expr === "") {
  console.error("usage: node scripts/cdp-eval.mjs --port 9222 --expr \"<js>\"");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("ws connect timeout")), 15000);
  ws.addEventListener("open", () => { clearTimeout(t); res(null); }, { once: true });
  ws.addEventListener("error", (e) => rej(e), { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(String(ev.data)); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.error) reject(new Error(`cdp error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const r = await send("Runtime.evaluate", { expression: `(async () => { return (${expr}); })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    console.error(`EXCEPTION: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(r.result?.value ?? null));
  process.exit(0);
} finally {
  ws.close();
}
