# verification — 製品 E2E

通常 build を対象とする Playwright E2E の正本。通常の transform 実装とは分離した test 用 Worker harness は使わない (`harness/` を参照)。

- `basic.spec.ts` — Web UI 基本 + self-test + 配信 header
- 実行: `npm run test:web` (設定は `playwright.config.ts`)
