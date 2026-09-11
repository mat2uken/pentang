# 02. 構成・配置・担当

## 処理経路

```text
                 共通UI (HTML/CSS/TypeScript)
                            |
                  ApplicationApi 3 methods
                            |
                  build modeでfactoryを選択
                    /                    \
          TauriBackend                 BrowserBackend
               |                            |
          Tauri invoke                postMessage
               |                            |
        共通Rust commands             Dedicated Worker ×1
               |                            |
        core-ffi                  Emscripten ES module
               |                            |
             C ABI                        C ABI
               |                            |
         native archive                 WASM module
                    \                    /
                     同一 cpp/src/core.cpp
```

Web実行時にRustやnativeサービスは不要。native WebView内でWASMを実行しない。失敗時の自動切り替えも行わない。

## 各部分が担当すること

| 部分 | 担当 | 入れない処理 |
|---|---|---|
| UI | 入力、状態表示、結果、self-test起動、Backendの破棄と再生成 | OS判定、invoke、Worker生成、WASMメモリ操作 |
| API型・検証 | 型、数値制限、入力のコピー、AppErrorの形 | Tauri / Worker型の公開、変換アルゴリズム |
| TauriBackend | 入力検証、要求数・タイマー・寿命管理、invoke結果の検査 | C++処理の代替実装、独自OSアダプター |
| Rust commands | IPC入力を検査しDTOへ変換、FFI呼び出し、エラー整形 | UI状態、emsdkへの依存 |
| core-ffi | C ABI宣言、配列の確保と寿命、status変換 | Tauriへの依存、raw pointerの公開API化 |
| BrowserBackend | Worker 1個、init、要求と返信の対応、終了処理 | WASM heapへの直接アクセス |
| Worker | protocol検査、factory初期化、直列実行、heapの確保・コピー・解放 | DOM、UI状態、ユーザー指定URL |
| C++ | 版情報、int32配列変換、checksum | OS分岐、動的確保、I/O、例外、RTTI、thread、STLコンテナ |

TSの入力検証と応答検証は小さな共通関数にする。Rust側の再検証は必要であり、数値計算を二重実装することとは区別する。通信管理を汎用RPCライブラリへ広げない。

## 1画面UIの操作仕様

| 表示・操作 | 内容 |
|---|---|
| 状態 | initializing / ready / failed / disposed。初期化失敗は理由を表示 |
| 実行情報 | backend、execution、hostOs、実CのABI/version |
| 入力 | valuesはJSON配列、multiplierとoffsetは整数欄。初期値は `[1,2,3]`、2、1 |
| 実行結果 | `[3,5,7]`、checksum 15が初期例。失敗時はcode/message |
| 操作 | 実行、共通self-test、破棄、再初期化。試験件数と失敗IDも表示 |

空の数値欄を0へ変換しない。UIの入力解析後もBackend側で同じ規則を検査する。通常の実行・self-test中は同じ操作の連打を抑止し、self-testは共通Application APIを通す。8要求の検査は専用試験で行う。破棄操作は実行中にも受け付け、古い処理で新しい画面を更新しない。

往復時間を出す場合はUI側の参考値と表示する。IPCや初期化を含むため、C++単体速度やnative/WASM性能比較の値として扱わない。公開APIに診断用methodを追加しない。

## 実装予定の配置

```text
README.md                      # 着手時に作る実行入口
package.json / package-lock.json
Cargo.toml / Cargo.lock / rust-toolchain.toml
.node-version / toolchains.lock.json
.gitattributes                 # テキストの改行を揃え、別OSでもsource hashを比較
index.html / vite.config.ts / tsconfig.*.json
src/main.ts / ui.ts / style.css
src/api/application-api.ts / validation.ts / errors.ts
src/backends/request-state.ts   # 今回の要求だけのpending/timer管理
src/backends/tauri/index.ts
src/backends/browser/index.ts / worker-protocol.ts / core.worker.ts / wasm-types.ts
src/self-test/                  # 画面からも使う試験。通常のtransform実装とは分離
cpp/include/core.h / cpp/src/core.cpp / cpp/tests/core_test.cpp
CMakeLists.txt
crates/core-ffi/Cargo.toml / build.rs / src/lib.rs
src-tauri/Cargo.toml / build.rs / tauri.conf.json / src/lib.rs / src/main.rs / src/commands.rs
src-tauri/permissions/ / capabilities/ / gen/android/ / gen/apple/
tests/fixtures/golden-vectors.json / tests/api/ / tests/web/
vitest.config.ts / playwright.config.ts
scripts/                       # doctor、ビルド、静的試験配信
web-public/wasm/                # 生成mjs/wasm。Git管理しない
dist/native/ / dist/web/        # 生成UI。Git管理しない
../reports/                       # 検証表・要約。生ログは別扱い
docs/                          # 本計画と固定した元定義
.github/workflows/             # M5で用意するtarget別CI
```

Cargo workspaceのmembersは `src-tauri` と `crates/core-ffi`。FFI単独試験は `cargo test -p core-ffi --locked` で選ぶ。CMakeはC++単体試験用で、製品のC++リンク経路は `cc` に一本化する。

これは完成時の配置である。M0では存在するsrc-tauriだけをworkspaceに入れ、FFI memberをM1で追加する。初期選択はRust 2024/resolver 3、Tauri package `core-app`、lib `core_app_lib`。Node単体試験は専用Vitest config、実Web試験はPlaywright Testと実Safariを使う。採用版はM0のlockで固定する。

## native / Webのビルド分離

| Vite mode | `@backend` | outDir | publicDir |
|---|---|---|---|
| tauri | `src/backends/tauri/index.ts` | `dist/native` | false |
| web | `src/backends/browser/index.ts` | `dist/web` | `web-public` |

選択はcomposition rootだけで行う。未知modeは設定エラーとし、UAや `__TAURI_INTERNALS__` で推測しない。UI用TypeScript pathsもmode別設定と一致させる。Window用DOM型、Worker用WebWorker型、Node用型を別tsconfigにし、手書きの小さなWASM型で生成物なしの型検査を可能にする。

Vitestは専用configを使い、Viteの製品mode判定を通さない。`tsconfig.native.json`、`web.json`、`worker.json`、`node.json`、`tests.json` をそれぞれの入力に適用し、native buildはnative/nodeだけを検査する。M0の空画面はBackendをimportせず、M1/M2の段階でalias接続する。

nativeの生成ファイルにwasm/mjs/Worker chunkがないこと、Webの実行import graphにTauri APIがないことをbuild時に確認する。npmにTauri CLIがdevDependencyとして存在することと、Web実行時にRustが必要なことを混同しない。

Workerの生成は `new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })` の静的構文を保ち、`worker.format = 'es'` とする。[Vite公式](https://vite.dev/guide/features#web-workers)

## Tauriの公開範囲

Tauriの独自commandは、既定では全window / WebViewから利用できる。capabilityファイルを置くだけで制限済みと判断せず、`src-tauri/build.rs` の `AppManifest::commands` に2commandを登録して権限管理の対象にする。[Tauri公式](https://v2.tauri.app/security/capabilities/)

実装時は次の一組を揃える。

1. `src-tauri/src/lib.rs` の共通runから `core_get_info / core_transform` を登録し、`corebin:` scheme (`/transform`・`/health`) を登録する。desktopの `main.rs` のみに置かない。
2. `tauri_build::AppManifest::new().commands(&["core_get_info", "core_transform"])` を既存のTauri build処理に組み込む。
3. `permissions/poc.toml` で `allow-core-api` を定義し、`commands.allow` はこの2個だけにする。
4. `capabilities/main-core.json` は `windows: ["main"]`、`permissions: ["allow-core-api"]` とし、remote URLを追加しない。`app.security.capabilities` で使用するcapabilityを明示する。
5. 不要なdefault capabilityやopener pluginを取り除く。frameworkの追加権限が実際に必要なら、個別権限と理由を記録する。
6. mainからの成功と、テスト専用の非許可windowからの拒否を実invokeで確認する。テストwindowを通常アプリへ残さない。

識別子やschemaは固定したtauri-build版で確認する。main windowの名前は表示titleではなくlabelを用いる。[AppManifest API](https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html)

## CSPと配信

nativeは同梱UIとTauri IPCに必要な最小CSPを設定し、`wasm-unsafe-eval` は加えない。dev用のLAN/HMR設定はdev用CSPへ分ける。[Tauri CSP](https://v2.tauri.app/security/csp/)

Webは外部URL、inline script、inline Workerを使わず、同一originのmodule WorkerとWASMを配信する。CSPはHTMLだけでなくWorker scriptのHTTP応答にも適用して試験する。具体的な配信条件は [05-build-run.md](05-build-run.md) に集約する。
