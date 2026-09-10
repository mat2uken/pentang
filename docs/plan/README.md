# 最初のPoC — 実施計画 v1.2

更新日: 2026-09-10。状態: **計画のレビュー・具体化、自動検証ラボの実装、Xperia と iPhone XS の実機検証まで完了。Windows・release黒箱は後続**。

同じHTML/CSS/TypeScript UIから、nativeではTauri＋Rust FFI、WebではWorker＋WASMを通して、同じC++処理を呼び出せるかを調べる。機能は版情報の取得と整数配列の変換に絞る。

今回の改訂では、前回の12件を [指摘対応表](11-review-traceability.md) で再点検し、残る8項目の曖昧さも補った。実装を27ステップへ分解し、編集先・依存・作業順・確認・失敗時の対処・終了条件を [詳細手順](03-implementation-plan.md) に揃えた。API/C ABI/protocol版は1のまま、機能範囲は拡大していない。

## 読み順と情報の置き場所

| 文書 | 判断できること |
|---|---|
| [00-overview.md](00-overview.md) | 目的、初回必須対象、後続対象、完了の呼び方 |
| [01-environment.md](01-environment.md) | 今回の実測、未確認事項、版の固定とdoctor |
| [02-architecture.md](02-architecture.md) | 処理の担当、配置、経路分離、Tauri権限 |
| [03-implementation-plan.md](03-implementation-plan.md) | M0〜M5の依存順、作業単位、成果物、終了条件 |
| [04-contracts.md](04-contracts.md) | API、数値、C ABI、通信・寿命・エラーの詳細 |
| [05-build-run.md](05-build-run.md) | 実装するコマンド、targetの対応、同梱アプリの起動手順 |
| [06-verification.md](06-verification.md) | 試験ID、受入判定、記録方法 |
| [07-decisions-risks.md](07-decisions-risks.md) | 継承した選択、今回の補足、未解決事項 |
| [08-handoff.md](08-handoff.md) | 最初の着手手順、Windows等への引き継ぎ |
| [09-review.md](09-review.md) | 旧計画の問題、改訂内容、レビューで確認できた範囲 |
| [10-sources.md](10-sources.md) | 照合した公式資料と用途 |
| [11-review-traceability.md](11-review-traceability.md) | 前回12件と追加8項目の対処、担当ステップ、確認試験 |
| [12-test-case-catalog.md](12-test-case-catalog.md) | 具体的な入力・故障条件・期待code・状態・回収条件 |
| [13-automated-validation-lab.md](13-automated-validation-lab.md) | 自動検証ラボの構成、冪等セットアップ、profile運用、実施結果、後続作業 |

## 正本と参照資料

実施順と仕様の補足は本計画v1.2に集約する。元の `web_tauri_cpp_poc_design_v1.zip` は変更せず、必要な型・C header・期待値の4ファイルを [reference/poc-v1](reference/poc-v1/README.md) に原文のまま同梱した。ZIPが別ホストになくても計画を読める。

実装開始時の配置先と移行方法は [04-contracts.md](04-contracts.md) に定義する。参照資料は過去版として固定し、実装用の型やheaderの第2の編集先にしない。ユーザーの指示が本計画に優先する。

## 現在地と次の作業

- 実装入口は `scripts/lab.mjs`、運用手順は [13-automated-validation-lab.md](13-automated-validation-lab.md) と `tools/device-lab/README.md` に移した。
- `feature/automated-device-validation` 上で、`full` profile が host、Web、debug Tauri、Android実機までPASSした。現行作業状態の Xperia と iPhone XS 再検証は `devices` profile の run 記録に保存している。
- iPhone XS の初回 `BLOCKED` は CoreDevice UUID と旧 pymobiledevice3 の経路差が原因だった。pymobiledevice3 11.12.1 の native RSD、hardware UDID 解決、devicectl による Safari URL起動、CDP の URL一致選択を追加し、現行 devices run で UI-01〜05 と W-02 まで PASS した。Windows、release黒箱、定期CIの実機jobは後続である。
- 検証表は [templates/verification-matrix.md](templates/verification-matrix.md)、従来の工程詳細は [03-implementation-plan.md](03-implementation-plan.md)、自動検証の実装・運用は [13-automated-validation-lab.md](13-automated-validation-lab.md) を使う。
