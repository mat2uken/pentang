# Common Core PoC

同じHTML/CSS/TypeScript UIから、nativeではTauri＋Rust FFI、WebではWorker＋WASMを通して、同じC++処理を呼び出せるかを調べるPoC。機能は版情報の取得と整数配列の変換に絞る。

- 目的・対象・完了条件: [docs/00-overview.md](docs/00-overview.md)
- 実装工程: [docs/03-implementation-plan.md](docs/03-implementation-plan.md)
- API/C ABI仕様: [docs/04-contracts.md](docs/04-contracts.md)
- ビルド・起動: [docs/05-build-run.md](docs/05-build-run.md)
- 検証・記録: [docs/06-verification.md](docs/06-verification.md)、[reports/verification-matrix.md](reports/verification-matrix.md)
- 工程tracker: [reports/implementation-tracker.md](reports/implementation-tracker.md)

## 初回必須対象

N-MAC / N-IOS-SIM / N-ANDROID-EMU / N-WIN / W-CHROMIUM / W-FIREFOX / W-SAFARI / W-IOS / W-ANDROID。後続: N-IOS-DEVICE / N-ANDROID-DEVICE。詳細は docs/00-overview.md。

## 現在の段階

M2-04 実施中。macOS実FFI・mobile最終リンク・Web実Worker/WASM (Chromium root/subpath) まで確認済み。実Safari・Firefox・mobileブラウザ・Windowsは未検証。

## 使い方

- Node 24.20.0 (`/opt/homebrew/opt/node@24/bin`) を使用。ホスト既定は変更しない。
  ```sh
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  npm ci
  npm run doctor -- --target <web|native|android|ios> --phase <tools|build|run>
  ```
- Web (emsdk 6.0.9を有効化して実行):
  ```sh
  source ~/emsdk/emsdk_env.sh
  npm run doctor -- --target web --phase build
  npm run build:web -- --base /
  npm run preview:web -- --base / --port 4173
  # subpathは停止後に別runで
  npm run build:web -- --base /poc/
  npm run preview:web -- --base /poc/ --port 4173
  ```
- macOS native:
  ```sh
  npm run doctor -- --target native --phase build
  cargo test -p poc-core-ffi --locked
  npm run tauri -- build --debug --target aarch64-apple-darwin --bundles app
  ```
- 開発配信 (M0のVite単独bootstrapは最終scriptへ置き換え済み):
  - Web開発: `npm run dev:web`
  - Native UI: `npm run dev:native-ui`
- 詳細は docs/05-build-run.md と reports を参照。

## 配置 (docs/04-contracts.md)

- `src/api/application-api.ts` ← `docs/reference/poc-v1/contracts/application-api.ts` (hash一致)
- `cpp/include/poc_core.h` ← `docs/reference/poc-v1/contracts/poc_core.h` (hash一致)
- `src/backends/browser/worker-protocol.ts` ← `docs/reference/poc-v1/contracts/worker-protocol.ts` (import 1行のみ変更: `./application-api` → `../../api/application-api`)
- `tests/fixtures/golden-vectors.json` ← `docs/reference/poc-v1/fixtures/golden-vectors.json` (hash一致)

参照元 `docs/reference/poc-v1` は過去版として固定し、実行コードから直接importしない。
