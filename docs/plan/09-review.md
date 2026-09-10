# 09. レビュー結果と改訂履歴

v1.1レビュー日: 2026-09-08。対象: 旧docs全10ファイル、元設計ZIPの設計・ビルド・受入資料と4定義、主要な公式資料。以下の12件と検査件数は初回レビューの記録として保持する。

**共通UI＋Tauri/Worker＋共通C++という構成は維持した。実装前に解消すべき仕様・手順の不足を補ったが、5環境で成立するかはまだ未検証である。**

## 指摘と対応

P1は実施判断や完了判定を誤る可能性がある項目、P2は再現性や作業効率を損なう項目。下表の「対応済み」は文書上の対応を意味する。

| ID | 重要度 | 旧計画の問題・影響 | v1.1の対応 |
|---|---|---|---|
| R1 | P1 | 必須環境が具体的な行として定義されず、実機とSim/Emu、Windows未実施が完了判定で混ざる | [00](00-overview.md) に初回必須9行・後続2行と完了の呼び方を定義 |
| R2 | P1 | iOS実機を未診断のままBLOCKEDと固定、Windows利用先も未確認 | [01](01-environment.md) で今回の実測と旧記録・推測を分離。未着手と前提不足を区別 |
| R3 | P1 | 正本がDownloadsのZIPと未作成directoryに依存し、別ホストで型・期待値を取得できない | [reference](reference/poc-v1/README.md) に原文4定義＋hashを保存。移行先も一意に定義 |
| R4 | P1 | Tauri commandを2個に絞る記述だけでは既定の全window公開を制限できない | [02](02-architecture.md) でAppManifest・permission・capabilityと実拒否試験を指定 |
| R5 | P1 | mobileのC++/SDKリンク問題がM4まで見つからない | [03](03-implementation-plan.md) でhost準備をM0、最終リンクをM1へ前倒し |
| R6 | P1 | timeout後の状態、全pending終了、getInfoのdispose後、古いfactory完了の扱いが曖昧 | [04](04-contracts.md) に状態遷移・エラー対応・世代処理を追加 |
| R7 | P2 | 入力変更、疎配列、未知field、Rustの1.0扱い、応答検査の説明が不足 | [04](04-contracts.md) で値の受理条件と受付時コピーを定義、A系列の試験へ対応 |
| R8 | P2 | SDK固定を全target一括と読める。iOS Simにも実機署名前提が混ざる | [01](01-environment.md) でtarget別doctor・段階ごとの固定を定義 |
| R9 | P2 | subpath配信、Worker CSP、404、端末選択と導入手順が手順書だけでは再現しにくい | [05](05-build-run.md) にbase付きbuild/配信、HTTP条件、target対応と導入操作を追加 |
| R10 | P2 | HOST≠TARGET時にホストのclangを一律誤りと判定する記述 | [05](05-build-run.md) でcompiler引数・SDK・object・最終リンクによる確認へ修正 |
| R11 | P2 | 応答が速い処理で9件目BUSYを再現できる保証がなく、leak判定も曖昧 | [06](06-verification.md) に制御した返信、件数/割当の確認、実経路試験との使い分けを追加 |
| R12 | P2 | 証跡に絶対path必須と個人path非commitが混在。自動commitも作業指示と混ざる | [06](06-verification.md) で共有要約とローカル記録を分け、[08](08-handoff.md) で変更・引き継ぎ範囲を明記 |

## v1.1で確認したこと

- 旧docs全10ファイルと参照元を読み、対象・処理経路・型/ABI・期待値・実行手順を照合した。
- 元ZIPの内部manifest 16項目と、同梱した4定義のSHA-256を照合した。
- goldenの正常10ケースと4096要素の生成ケースについて、独立した整数計算で配列全要素とchecksumが一致した。
- ホストのOS/CPU、Xcode/SDK、Node/npm、Rust/Cargo、CMake、JDKを読み取り専用で再取得した。
- Tauriの独自command公開範囲、CLI target、Vite Worker構文、Emscripten設定、NDK関連は [公式資料](10-sources.md) と照合した。
- 改訂後のMarkdown 15ファイル、文書内の相対リンク54件、表の列数、JSON 2ファイルを検査し、問題なし。必須9行・後続2行の一致と、試験ID 22個への参照も確認した。

今回変更した範囲はdocs内のみ。参照用の型/headerを含め、アプリ本体、SDK、Git、実機の変更は行っていない。

## 残る未検証事項

実装コード、Node 24上の依存整合、Emscripten実exports、FFIの最終リンク、mobile host、実ブラウザ、CSP、同梱起動、Windows利用可否、性能は未検証。文書の整合や期待値の再計算をこれらの成功として扱わない。

M0で解く未決事項は [07-decisions-risks.md](07-decisions-risks.md) に集約した。今回の修正により着手順と判定方法は定まったが、採用判断はM1〜M5の実測後に行う。

## v1.2の再点検

前回12件を [11の対応表](11-review-traceability.md) で仕様・作業・試験まで追跡し、全件の文書対処を確認した。さらに、bootstrap、工程の詳細、Rust IPC、実装時期、doctorのphase、test runner、再現性、異常系の具体条件という8項目を補った。

[03](03-implementation-plan.md) から読める詳細手順3冊に27ステップを定義し、[12](12-test-case-catalog.md) に具体ケースを追加した。toolchainの具体版と利用先等の実測が必要な項目はO1〜O7として残し、解決手順と完了条件を記載した。実装・SDK導入・Git変更・アプリ試験は今回も未実施である。

v1.2の最終点検では、Markdown 21ファイル、相対リンク144件と明示anchor 32件、27ステップの必須記入項目と依存関係、22受入ID、60具体ケース、必須9行/後続2行を検査し、欠落・循環・参照不整合はなかった。元4定義はZIPとのbyte一致を再確認し、正常10ケースと4096要素の期待値も独立した整数計算で再照合した。これらは文書とデータの検査結果である。
