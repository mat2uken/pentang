# 03. 実装工程 v1.2

実装は27ステップで進める。各リンク先に前提、編集先、番号付き手順、確認、失敗時の対処、終了条件を記載した。現時点では全ステップ未着手である。

- [手順1: 準備とnative経路](implementation/01-setup-native.md)
- [手順2: Web経路と異常系](implementation/02-web-lifecycle.md)
- [手順3: 環境別検証と採用判断](implementation/03-platform-verification.md)
- [指摘と作業・試験の対応](11-review-traceability.md)
- [試験ケースの具体値](12-test-case-catalog.md)
- [工程trackerの雛形](templates/implementation-tracker.md)

## 進め方

基本順はM0→M1→M2→M3→M4→M5。Windows利用先の確認はM0、mobileの最終リンクはM1で早く行う。初回mobileはSim/Emu、実機は後続という範囲を維持する。

1. 次表の依存ステップと、その対象のtool/成果物の前提を確認する。
2. 関連ファイルだけを編集し、指定した確認を行う。計算やvalidation/権限を一時的な偽の実装で通さない。
3. trackerに状態、試験ID、run ID、障害と次の操作を記録して次へ進む。
4. 同じ成功確認を無条件に繰り返さず、変更・失敗・別targetの確認に必要なものを選ぶ。時間のかかるユニットテスト・端末検証はLuna Mediumに任せ、結果のみを受け取る。
5. commitとpushは個別の依頼に従う。段階の区切りは差分をレビューできる単位であり、自動commitの指示ではない。

M0-05は診断結果と不足を記録できれば終了できる。M1-05はtarget別に最終リンクの成功が必要で、iOS側だけ成功ならM4-03へ進める。Android側を待つ必要はない。M4-06も利用可能なbrowserから進め、未実施行は残す。依存表は並列実行やサブエージェントの追加指示ではない。

## ステップ一覧と依存

| ID | 作業 | 依存 | 詳細 |
|---|---|---|---|
| M0-01 | 開始状態・参照定義・記録の準備 | 実装着手の依頼 | [手順](implementation/01-setup-native.md#m0-01) |
| M0-02 | 版と実装上の初期選択を固定 | M0-01 | [手順](implementation/01-setup-native.md#m0-02) |
| M0-03 | Node scripts・doctorを用意 | M0-02 | [手順](implementation/01-setup-native.md#m0-03) |
| M0-04 | Tauri/Viteの空画面を成立 | M0-03 | [手順](implementation/01-setup-native.md#m0-04) |
| M0-05 | mobile hostと実行環境を選定 | M0-04 | [手順](implementation/01-setup-native.md#m0-05) |
| M1-01 | 共通C++とC単体試験 | M0-04 | [手順](implementation/01-setup-native.md#m1-01) |
| M1-02 | Cargo workspaceとsafe FFI | M1-01 | [手順](implementation/01-setup-native.md#m1-02) |
| M1-03 | Rust command・DTO・公開範囲 | M1-02 | [手順](implementation/01-setup-native.md#m1-03) |
| M1-04 | TauriBackend・共通UI・self-test | M1-03 | [手順](implementation/01-setup-native.md#m1-04) |
| M1-05 | mobile向け最終リンク | M0-05, M1-04 | [手順](implementation/01-setup-native.md#m1-05) |
| M2-01 | EmscriptenとWASM生成 | M1-01 | [手順](implementation/02-web-lifecycle.md#m2-01) |
| M2-02 | Workerのinitとheap処理 | M2-01 | [手順](implementation/02-web-lifecycle.md#m2-02) |
| M2-03 | BrowserBackendと共通UI接続 | M1-04, M2-02 | [手順](implementation/02-web-lifecycle.md#m2-03) |
| M2-04 | 配信buildと2ブラウザで確認 | M2-03 | [手順](implementation/02-web-lifecycle.md#m2-04) |
| M3-01 | 入力・応答・確保失敗を検査 | M2-04 | [手順](implementation/02-web-lifecycle.md#m3-01) |
| M3-02 | 通信競合と監視期限を検査 | M3-01 | [手順](implementation/02-web-lifecycle.md#m3-02) |
| M3-03 | 破棄・再生成とUI状態を検査 | M3-02 | [手順](implementation/02-web-lifecycle.md#m3-03) |
| M3-04 | 権限・CSP・生成物分離を検査 | M3-03 | [手順](implementation/02-web-lifecycle.md#m3-04) |
| M4-01 | 採用候補と共通操作を固定 | M3-04 | [手順](implementation/03-platform-verification.md#m4-01) |
| M4-02 | macOS同梱アプリを検証 | M4-01 | [手順](implementation/03-platform-verification.md#m4-02) |
| M4-03 | iOS Simulatorで検証 | M1-05, M4-01 | [手順](implementation/03-platform-verification.md#m4-03) |
| M4-04 | Android Emulatorで検証 | M1-05, M4-01 | [手順](implementation/03-platform-verification.md#m4-04) |
| M4-05 | WindowsでFFIとexeを検証 | M4-01 | [手順](implementation/03-platform-verification.md#m4-05) |
| M4-06 | 全Webブラウザを検証 | M4-01, M0-05 | [手順](implementation/03-platform-verification.md#m4-06) |
| M5-01 | クリーン再現とSDK独立性 | M4-01 | [手順](implementation/03-platform-verification.md#m5-01) |
| M5-02 | CI workflowを準備 | M3-04 | [手順](implementation/03-platform-verification.md#m5-02) |
| M5-03 | 全記録を監査して採用判断 | M4-02, M4-03, M4-04, M4-05, M4-06, M5-01, M5-02 | [手順](implementation/03-platform-verification.md#m5-03) |

## 段階を終える条件

| 段階 | 必要な結果 | まだ結論しないこと |
|---|---|---|
| M0 | 版/記録/空画面と対象別の前提が明確 | C++処理成功 |
| M1 | macOSの実FFIとC++/Rust試験、mobile最終リンクの結果 | Webやmobile UIの成功 |
| M2 | Chromium/実Safariでroot/subpathの実Worker/WASM、nativeと同じ期待値 | 残るbrowserと異常系全体 |
| M3 | 入力・通信・寿命・権限・CSPの対象試験PASS | Windows/mobileの実起動 |
| M4 | 初回必須9行の起動・self-test・該当する同梱起動PASS | SDK独立性や実機確認 |
| M5 | 採用source、再現性、必須共通試験、全結果が対応 | 対象外の性能・商用配布 |

未実施・障害がある場合はその段階の成功範囲だけを記録する。文書改訂の完了とアプリ実装・検証の完了は別である。環境不足があっても、依存しない手順・CI設定・引き継ぎ資料は進める。
