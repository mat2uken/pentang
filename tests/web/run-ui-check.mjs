import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("FAIL") || t.toLowerCase().includes("error")) console.log(`[console] ${t}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e)}`));
await page.goto(url, { waitUntil: "load" });
// readyを待つ
await page.waitForFunction(
  () => document.getElementById("status")?.textContent === "ready",
  { timeout: 30000 },
);
const backendInfo = await page.textContent("#backend-info");
console.log(`backend-info: ${backendInfo}`);
if (!backendInfo?.includes("wasm-worker") || !backendInfo?.includes("dedicated-worker") || !backendInfo?.includes("abi: 1")) {
  console.error("backend info mismatch");
  await browser.close();
  process.exit(1);
}
// 基本変換
await page.click("#run");
await page.waitForFunction(
  () => document.getElementById("result")?.textContent?.includes("checksum=15") ?? false,
  { timeout: 15000 },
);
console.log(`result: ${await page.textContent("#result")}`);
// self-test
await page.click("#selftest");
await page.waitForFunction(
  () => document.getElementById("selftest-result")?.textContent?.includes("success 11/11") ?? false,
  { timeout: 30000 },
);
console.log(`selftest: ${await page.textContent("#selftest-result")}`);
// dispose基本動作
await page.click("#dispose");
await page.waitForFunction(
  () => document.getElementById("status")?.textContent === "disposed",
  { timeout: 10000 },
);
console.log("dispose ok");
// 再初期化
await page.click("#reinit");
await page.waitForFunction(
  () => document.getElementById("status")?.textContent === "ready",
  { timeout: 30000 },
);
console.log("reinit ok");
await browser.close();
console.log("BROWSER UI PASS");
