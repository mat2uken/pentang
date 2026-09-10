# harness — 手動検証用 harness

通常 build・通常 E2E には混ぜない test 用入口と確認 script。製品 E2E は `../verification/` を使う。

- `harness.ts` + `worker-harness.html` — Worker 単独呼びの確認入口 (Vite 開発配信で使用)
- `run-harness.mjs` — harness の自動実行
- `run-ui-check.mjs` — 開発配信 UI の確認
