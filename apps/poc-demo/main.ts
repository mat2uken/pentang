import { boot } from "./ui";

// The WebDriverIO guest plugin is loaded only for the debug packaged-E2E build.
// Release and ordinary native builds keep the testing bridge out of the UI bundle.
const wdioFlag = (import.meta as ImportMeta & { env?: { VITE_WDIO?: string } }).env?.VITE_WDIO;
const wdioReady = wdioFlag === "1" ? import("@wdio/tauri-plugin") : Promise.resolve();

window.addEventListener("DOMContentLoaded", () => {
  // bootの拒否は要素欠落などの結線不備のみ。Backend失敗はboot内部で画面表示する。
  // 画面に残さず握りつぶすとinitializingのまま原因不明になるため、ここで可視化する。
  void wdioReady.then(() => boot()).catch((e: unknown) => {
    const status = document.getElementById("status");
    if (status) status.textContent = "failed";
    const error = document.getElementById("error");
    if (error) {
      error.textContent = `boot failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
});
