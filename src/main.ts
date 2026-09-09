import { boot } from "./ui";

window.addEventListener("DOMContentLoaded", () => {
  // bootの拒否は要素欠落などの結線不備のみ。Backend失敗はboot内部で画面表示する。
  // 画面に残さず握りつぶすとinitializingのまま原因不明になるため、ここで可視化する。
  void boot().catch((e: unknown) => {
    const status = document.getElementById("status");
    if (status) status.textContent = "failed";
    const error = document.getElementById("error");
    if (error) {
      error.textContent = `boot failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
});
