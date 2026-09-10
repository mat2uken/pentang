# 最初のPoC — 実施計画 v1.2

更新日: 2026-09-08。状態: **計画のレビュー・具体化まで完了。アプリ実装・ビルド・起動試験は未実施**。

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

## 正本と参照資料

実施順と仕様の補足は本計画v1.2に集約する。元の `web_tauri_cpp_poc_design_v1.zip` は変更せず、必要な型・C header・期待値の4ファイルを [reference/poc-v1](reference/poc-v1/README.md) に原文のまま同梱した。ZIPが別ホストになくても計画を読める。

実装開始時の配置先と移行方法は [04-contracts.md](04-contracts.md) に定義する。参照資料は過去版として固定し、実装用の型やheaderの第2の編集先にしない。ユーザーの指示が本計画に優先する。

## 現在地と次の作業

- 作業先はGit未初期化。レビュー開始時は既存の `docs/` のみで、branch・HEADは存在しなかった。
- 旧計画の「Node 24 LTS」「iOS Simulator先行」「Android Emulatorのみ」を継承した。最新版の組み合わせやSDK適合は未検証。
- 実装着手時はM0から開始する。今回の文書改訂を、SDK導入・Git初期化・アプリ実装・commit・pushの実施記録として扱わない。
- 検証表は [templates/verification-matrix.md](templates/verification-matrix.md)、実行記録は [templates/run-record.md](templates/run-record.md)、版固定の雛形は [templates/toolchains.lock.example.json](templates/toolchains.lock.example.json) を使う。
- 着手する人は03の工程表から [M0-01](implementation/01-setup-native.md#m0-01) へ進む。[工程tracker](templates/implementation-tracker.md) は全27ステップNOT_STARTEDで開始する。
