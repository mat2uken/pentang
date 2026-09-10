# packages — ライブラリ

PoC の検証対象であり、再利用する部分。UI・配信・署名を持たず、`apps/`・`src-tauri/` から利用される。

## 一覧

| 配置 | 内容 | プラットフォーム |
|---|---|---|
| `core/` | C++ 共通コア (`include/poc_core.h`, `src/core.cpp`, `tests/core_test.cpp`)。OS・Tauri・Emscripten 非依存 | 共通 |
| `ffi/` | Rust FFI (`poc-core-ffi`)。unsafe 封じ・寿命管理。Tauri 非依存 | ネイティブ共通 |
| `api/` | TS 共通 API (`application-api.ts`, `errors.ts`, `validation.ts`) + 契約 fixture (`fixtures/golden-vectors.json`) | 共通 |
| `backends/` | TS バックエンド。直下の `pipeline.ts`・`request-state.ts` は両 backend 共有 | — |
| `backends/browser/` | Worker + WASM 経由 (`index.ts`, `core.worker.ts`, `worker-protocol.ts`, `wasm-types.ts`) | Web |
| `backends/tauri/` | Tauri invoke 経由 (`index.ts`) | ネイティブ (TS 側) |

## 依存方向

- `core` ← `ffi` / `core` → (Emscripten) → WASM ← `backends/browser`
- `api` ← `backends/*` ← アプリ (`apps/demo`、`src-tauri` の commands)
- `browser` と `tauri` は互いを import しない。共有は `pipeline.ts` / `request-state.ts` のみ。

## 試験・ビルド

- C++ 単体: `npm run test:core`
- Rust FFI: `cargo test -p poc-core-ffi --locked`
- TS 単体 (`tests/api/`、契約 fixture 準拠): `npm run test:api`
- 仕様の由来: `research/docs/04-contracts.md`。凍結した原文は `research/docs/reference/poc-v1/` (実行コードから import しない)。
