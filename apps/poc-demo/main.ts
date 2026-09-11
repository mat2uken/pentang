import { boot } from "./ui";

// The WebDriverIO guest plugin is loaded only for the debug packaged-E2E build.
// Release and ordinary native builds keep the testing bridge out of the UI bundle.
const wdioFlag = (import.meta as ImportMeta & { env?: { VITE_WDIO?: string } }).env?.VITE_WDIO;
const wdioReady = wdioFlag === "1" ? import("@wdio/tauri-plugin") : Promise.resolve();

// `?bench=1` でのみ別chunkのベンチを走らせ、結果JSONを #bench-output に出す。
// 通常UIの結線・表示には触らない。sim/実機の無人回収用にビルド時env
// (`VITE_BENCH_AUTOSTART=1`) でも起動する (結果は `?report=` / env先へPOST)。
async function bootBench(): Promise<boolean> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  let autostart = false;
  try {
    autostart =
      (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.[
        "VITE_BENCH_AUTOSTART"
      ] === "1";
  } catch {
    autostart = false;
  }
  if (!params.has("bench") && !autostart) return false;
  const pre = document.createElement("pre");
  pre.id = "bench-output";
  pre.textContent = "bench: running";
  document.body.appendChild(pre);
  try {
    const { runBench } = await import("./self-test/bench-runner");
    const report = await runBench();
    pre.textContent = JSON.stringify(report);
  } catch (e) {
    pre.textContent = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
  return true;
}

window.addEventListener("DOMContentLoaded", () => {
  // bootの拒否は要素欠落などの結線不備のみ。Backend失敗はboot内部で画面表示する。
  // 画面に残さず握りつぶすとinitializingのまま原因不明になるため、ここで可視化する。
  void wdioReady
    .then(async () => {
      if (await bootBench()) return;
      await boot();
    })
    .catch((e: unknown) => {
      const status = document.getElementById("status");
      if (status) status.textContent = "failed";
      const error = document.getElementById("error");
      if (error) {
        error.textContent = `boot failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
});
