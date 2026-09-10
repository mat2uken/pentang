# Common Core PoC

同じ TypeScript UI から、native (Tauri + Rust FFI) と Web (Worker + WASM) で同じ C++ 処理を呼び出す PoC。機能は版情報の取得と整数配列の変換に絞る。

## 構成

- `packages/` — ライブラリ (ビルド・利用する部分)。詳細は [packages/README.md](packages/README.md)
  - `core/` C++ 共通コア / `ffi/` Rust FFI 共通 / `api/` TS 共通 API / `backends/` 共有 + プラットフォーム別 (browser / tauri)
- `apps/demo/` + `src-tauri/` + `index.html` — ライブラリ利用側の PoC デモ (UI・ネイティブシェル)。詳細は [apps/README.md](apps/README.md)
- `research/` — 調査・検証の集約 (計画文書・検証表・実行記録・E2E)。詳細は [research/README.md](research/README.md)
- `scripts/` / `tests/api/` — ビルド・検証ツールとライブラリ単体試験

## 使い方

- Node 24.20.0 を使用 (ホスト既定は変更しない)。
  ```sh
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  npm ci
  npm run doctor -- --target <web|native|android|ios> --phase <tools|build|run>
  ```
- 型検査・試験: `npm run typecheck -- --scope all` / `npm run test:api` / `npm run test:core` / `cargo test -p poc-core-ffi --locked`
- Web (emsdk 6.0.9 を有効化して実行): `npm run build:web -- --base /` → `npm run preview:web`
- macOS native: `npm run tauri -- build --debug --target aarch64-apple-darwin --bundles app`
- 開発配信: `npm run dev:web` (Web) / `npm run dev:native-ui` (Native UI)

## 状態

検証の最新状況は [research/README.md](research/README.md) と [research/reports/verification-matrix.md](research/reports/verification-matrix.md) を参照。
