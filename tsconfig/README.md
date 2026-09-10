# tsconfig — 用途別 TypeScript 設定

ルート直下の `tsconfig.*.json` 乱立を避けるため、用途別プロジェクトをこのディレクトリに集約する。
単一 `tsconfig.json` への統合はしない。`lib` / `types` / `@backend` の alias が
web / native / worker / node で競合し、型分離が壊れるためである。

| ファイル | 用途 | lib/types | `@backend` |
|---|---|---|---|
| `base.json` | 共通 strict/noEmit 基底 | — | — |
| `native.json` | Tauri ネイティブ UI | ES2022 + DOM | `packages/backends/tauri` |
| `web.json` | Web UI + harness | ES2022 + DOM + vite/client | `packages/backends/browser` |
| `worker.json` | WebWorker + WASM 型 | ES2022 + WebWorker | — |
| `node.json` | scripts / vite.config | ES2022 + node | — |
| `tests.json` | `tests/api` 単体試験 | ES2022 + DOM + node/vite | tauri |

ルートの `tsconfig.json` はエディタ/IDE 用の束ね (references) であり、型検査の実体は
`node scripts/typecheck.mjs -- --scope <native|web|all>` が各プロジェクトを `tsc -p tsconfig/<name>.json` で実行する。
