import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:5173/tests/web/worker-harness.html";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e)}`));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(
  () => (window).__harnessDone === true,
  { timeout: 60000 },
);
const failed = await page.evaluate(() => (window).__harnessFailed);
const text = await page.textContent("#out");
console.log("---HARNESS OUT---");
console.log(text);
console.log(`failed=${String(failed)}`);
await browser.close();
if (failed !== 0) process.exit(1);
