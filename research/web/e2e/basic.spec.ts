import { expect, test } from "@playwright/test";

// 製品E2E。通常のtransform実装とは分離したtest用Worker harnessは使わない。
test("web UI basic + self-test", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "/", { waitUntil: "load" });
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 30000 });
  const info = (await page.textContent("#backend-info")) ?? "";
  expect(info).toContain("wasm-worker");
  expect(info).toContain("dedicated-worker");
  expect(info).toContain("abi: 1");

  await page.click("#run");
  await expect(page.locator("#result")).toContainText("checksum=15", { timeout: 15000 });

  await page.click("#selftest");
  await expect(page.locator("#selftest-result")).toContainText("success 11/11", { timeout: 30000 });

  // crossOriginIsolated=falseで成功することを確認 (COOP/COEPを要求しない)
  const isolated = await page.evaluate(() => (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated);
  expect(isolated).toBe(false);
});

test("delivery headers: MIME/CSP/no-store/404", async ({ request, baseURL }) => {
  const base = (baseURL ?? "http://127.0.0.1:4173/").replace(/\/$/, "/");
  const expectedCSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";

  const html = await request.get(base);
  expect(html.status()).toBe(200);
  expect(html.headers()["content-type"] ?? "").toContain("text/html");
  expect(html.headers()["content-security-policy"] ?? "").toBe(expectedCSP);
  expect(html.headers()["cache-control"] ?? "").toBe("no-store");

  const mjs = await request.get(new URL("wasm/poc-core.mjs", base).toString());
  expect(mjs.status()).toBe(200);
  expect(mjs.headers()["content-type"] ?? "").toContain("javascript");
  expect(mjs.headers()["content-security-policy"] ?? "").toBe(expectedCSP);

  const wasm = await request.get(new URL("wasm/poc-core.wasm", base).toString());
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"] ?? "").toBe("application/wasm");

  const missing = await request.get(new URL("wasm/missing.wasm", base).toString());
  expect(missing.status()).toBe(404);
  expect((await missing.text()).toLowerCase()).not.toContain("<!doctype");

  const outside = await request.get("/outside-prefix-test");
  // root配信では/配下のため200/404のいずれも許すが、subpath配信ではprefix外は404
  expect([200, 404]).toContain(outside.status());
});
