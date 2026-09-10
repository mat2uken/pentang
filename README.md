# Common Core PoC

同じ TypeScript UI から、native (Tauri + Rust FFI) と Web (Worker + WASM) で同じ C++ 処理を呼び出す PoC。機能は版情報の取得と整数配列の変換に絞る。

## 構成

- `packages/` — ライブラリ (ビルド・利用する部分)。詳細は [packages/README.md](packages/README.md)
  - `core/` C++ 共通コア / `ffi/` Rust FFI 共通 / `api/` TS 共通 API / `backends/` 共有 + プラットフォーム別 (browser / tauri)
- `apps/poc-demo/` + `src-tauri/` + `index.html` — デモアプリ (ライブラリ利用側の PoC デモ: UI・ネイティブシェル)。製品コードではない。詳細は [apps/README.md](apps/README.md)
- `docs/` — ドキュメント集約 (計画・仕様・調査結果・検証記録・E2E)。詳細は [docs/README.md](docs/README.md)
- `scripts/` / `tests/api/` — ビルド・検証ツールとライブラリ単体試験
- `tsconfig/` — 用途別 TypeScript 設定 (束ねはルート `tsconfig.json`)。詳細は [tsconfig/README.md](tsconfig/README.md)

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

自動検証ラボは `scripts/lab.mjs` を入口にする。まず `npm run lab -- setup --apply --target all` で依存関係とツールを確認し、変更が小さいときは `npm run lab -- run --profile affected --changed`、配布物と接続端末まで確認するときは `npm run lab -- run --profile full --android-serial <adb-serial> --preview-host <LAN-address>` を使う。実行結果は `.lab-state/runs/<run-id>/` に保存される。詳細は [tools/device-lab/README.md](tools/device-lab/README.md) を参照。

## 状態

検証の最新状況は [docs/README.md](docs/README.md) と [docs/reports/verification-matrix.md](docs/reports/verification-matrix.md) を参照。
