# docs — ドキュメント集約

PoC の計画・仕様・調査結果・検証記録・E2E を一箇所にまとめたもの。
今後は調査結果や検証結果だけでなく、ドキュメント類もここに集約する。新規ドキュメントの置き場所は下表に従う。
実装の現行配置は [packages/README.md](../packages/README.md) を参照。

## 中身

- `plan/` — 計画 v1.2 文書群 (概要・環境・構成・工程・契約・ビルド手順・検証計画・決定事項・引継ぎ・レビュー・資料・試験カタログ + 工程詳細 `implementation/` + 雛形 `templates/` + 凍結参照 `reference/`)。仕様・計画の正本
- `reports/` — 検証表 (`verification-matrix.md`)・工程 tracker (`implementation-tracker.md`)・監査レポート (`implementation-report.md`)。`local/` は実測ログ (Git 対象外)
- `verification/` — Playwright E2E (`basic.spec.ts`)。製品 E2E の正本
- `harness/` — Web 検証用 harness (`harness.ts`, `worker-harness.html`, `run-harness.mjs`, `run-ui-check.mjs`)。通常 build・通常 E2E には混ぜない手動検証用

## 新規ドキュメントの置き場所

| 種別 | 置き場所 |
|---|---|
| 仕様・計画・設計 | `plan/` |
| 調査結果・技術検証メモ | `plan/` または該当主題の新規 `.md` (恒久化するもの)。使い捨てメモは `reports/local/` |
| 検証結果・監査・工程記録 | `reports/` (生ログ・個人情報入りは `reports/local/`) |
| E2E・回帰試験 | `verification/` |
| 手動 harness・確認手順 | `harness/` |

## 読み順 (初見用)

1. `plan/00-overview.md` (目的・対象・完了条件)
2. `plan/02-architecture.md` (処理経路)
3. `plan/04-contracts.md` (API・C ABI 仕様)
4. `reports/verification-matrix.md` + `reports/implementation-report.md` (検証結果)

## 現状 (要点のみ)

- 必須 9 行中、N-MAC / N-IOS-SIM / N-ANDROID-EMU / W-CHROMIUM / W-FIREFOX / W-SAFARI / W-ANDROID / W-IOS は PASS、N-WIN は BLOCKED (ホスト未選定)。詳細は `reports/` を参照。
- `plan/` 内のファイル配置・パス表記は計画当時のもので、現行配置と異なる場合がある (例: `src/api` → `packages/api`、`apps/demo` → `apps/poc-demo`、`research/` → `docs/`)。正は `packages/`・`apps/` の実ファイル。
- 実行記録の雛形は `plan/templates/run-record.md` を使用する。
