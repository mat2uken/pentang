# 10. 公式資料と照合範囲

確認日: 2026-09-08。公式資料は更新されるため、実装時には固定した版の資料・CLI help・生成schemaを照合する。リンク先の最新版をそのまま採用版とする意味ではない。

| 資料 | この計画で確認した事項 |
|---|---|
| [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | WindowsのMSVC/WebView2、mobile SDK、Xcode/CocoaPods等の前提 |
| [Tauri CLI](https://v2.tauri.app/reference/cli/) | desktop build、android buildのAPK/target、ios buildのaarch64-sim |
| [Tauri capabilities](https://v2.tauri.app/security/capabilities/) | 独自commandの既定公開範囲、window label、capability選択、remote設定 |
| [tauri-build AppManifest](https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html) | commands登録とpermission生成。具体版をM0で固定 |
| [Tauri CSP](https://v2.tauri.app/security/csp/) | 同梱UIのCSP設定と許可範囲 |
| [Tauri Vite](https://v2.tauri.app/start/frontend/vite/) | dev port、mobileのTAURI_DEV_HOST、hook設定 |
| [cc crate](https://docs.rs/cc/latest/cc/) | Cargo build.rsからのC/C++ビルドとtarget別compiler設定 |
| [Vite Worker](https://vite.dev/guide/features#web-workers) | new Workerの静的構文とmodule Workerの扱い |
| [Vite production build](https://vite.dev/guide/build#public-base-path) | base指定による配信pathの処理 |
| [Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html) | 通常の非同期factoryとES module出力 |
| [Emscripten settings](https://emscripten.org/docs/tools_reference/settings_reference.html) | exports、memory growth、malloc、WASM/JS生成設定 |
| [Android NDK other build systems](https://developer.android.com/ndk/guides/other_build_systems) | target/API付きcompiler、sysroot、host-tag |
| [Android C++ support](https://developer.android.com/ndk/guides/cpp-support) | C++ runtimeと共有ライブラリ数による判断 |
| [Node releases](https://nodejs.org/en/about/previous-releases) | Node 24系のLTS位置づけ |
| [Vitest guide](https://vitest.dev/guide/) | 具体版の前提条件、run、専用configによるtest設定 |
| [Playwright browsers](https://playwright.dev/docs/browsers) | 実browserの導入と、WebKit/viewportをSafari/実mobileと区別する理由 |
| [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html) | virtual workspaceのmembersとresolver明示 |
| [Rust Vec](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.try_reserve_exact) | 捕捉可能な確保失敗と有効なVecの確保 |
| [Worker terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate) | Workerは処理完了を待たず停止するため、pendingは呼出し側で終了させる |

本計画の8要求、5秒/15秒監視、4096要素、C ABI、初回必須行、CSPの具体的な基準値はPoCとしての設計選択であり、上記フレームワーク全般の制限ではない。選んだ組み合わせが実際に動くことは、実装後の試験で確認する。
