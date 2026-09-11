function requireText(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ゲストプラグイン欠落時は全コマンドが5秒超のタイムアウトを積み上げるため、
// 先頭で即時判定する (VITE_WDIO=1 なしで組まれたバイナリの取り違え対策)。
async function requireGuestPlugin() {
  const present = await browser.execute(() => typeof window.wdioTauri !== "undefined");
  if (!present) {
    throw new Error("guest plugin missing: rebuild the binary with VITE_WDIO=1");
  }
}

async function waitForText(selector, expected, timeout = 30000) {
  await browser.waitUntil(
    async () => (await browser.$(selector).getText()).includes(expected),
    { timeout, interval: 250, timeoutMsg: `${selector} did not contain ${expected}` },
  );
}

describe("packaged Tauri UI", () => {
  it("runs the common lifecycle through the real WebView and native backend", async () => {
    await requireGuestPlugin();
    await waitForText("#status", "ready");

    const info = await $("#backend-info").getText();
    requireText(info, "tauri-native", "backend");
    requireText(info, "native-ffi", "execution");
    requireText(info, "abi: 1", "abi");

    await $("#run").click();
    await waitForText("#result", "result: [3,5,7] checksum=15");

    await $("#selftest").click();
    await waitForText("#selftest-result", "self-test: success 11/11", 60000);
    await waitForText("#selftest-result", "invalid 7/7", 60000);

    await $("#dispose").click();
    await waitForText("#status", "disposed");
    if (await $("#run").isEnabled()) {
      throw new Error("run must be disabled after dispose");
    }

    await $("#reinit").click();
    await waitForText("#status", "ready");
    await $("#run").click();
    await waitForText("#result", "result: [3,5,7] checksum=15");
  });
});
