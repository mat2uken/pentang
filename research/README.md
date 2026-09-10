# research — 調査・検証の集約

PoC の計画・仕様・検証記録・E2E を一箇所にまとめたもの。実装の現行配置は [packages/README.md](../packages/README.md) を参照。

## 中身

- `docs/` — 計画 v1.2 文書群 (概要・環境・構成・工程・契約・ビルド手順・検証計画・決定事項・引継ぎ・レビュー・資料・試験カタログ + 工程詳細 `implementation/` + 雛形 `templates/`)
- `reports/` — 検証表 (`verification-matrix.md`)・工程 tracker (`implementation-tracker.md`)・監査レポート (`implementation-report.md`)。`local/` は実測ログ (Git 対象外)
- `web/` — Web 検証用 harness と Playwright E2E (`e2e/basic.spec.ts`)

## 読み順 (初見用)

1. `docs/00-overview.md` (目的・対象・完了条件)
2. `docs/02-architecture.md` (処理経路)
3. `docs/04-contracts.md` (API・C ABI 仕様)
4. `reports/verification-matrix.md` + `reports/implementation-report.md` (検証結果)

## 現状 (要点のみ)

- 必須 9 行中、N-MAC / N-IOS-SIM / N-ANDROID-EMU / W-CHROMIUM / W-FIREFOX / W-SAFARI / W-ANDROID は PASS 相当、W-IOS は PARTIAL、N-WIN は BLOCKED (ホスト未選定)。詳細は `reports/` を参照。
- `docs/` 内のファイル配置・パス表記は計画当時のもので、現行配置と異なる場合がある (例: `src/api` → `packages/api`)。正は `packages/`・`apps/` の実ファイル。
- 実行記録の雛形は `docs/templates/run-record.md` を使用する (旧 `reports/run-record-template.md` と同文のため 1 つに集約した)。
