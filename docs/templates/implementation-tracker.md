# 実装工程tracker

計画版: v1.2。`reports/implementation-tracker.md` にコピーして使用する。ここにあるDONEは工程の完了で、アプリの各試験のPASSとは区別する。

状態: NOT_STARTED / IN_PROGRESS / BLOCKED / DONE。必須の成功確認が残る実装・検証工程をDONEにしない。診断工程は不足内容と再開条件の記録までを終了条件にできる。M1-05やM4-06は対象ごとに行を分けてよい。

| ステップ | 作業 | 状態 | 対象・担当 | run/試験ID | 障害・次の操作 |
|---|---|---|---|---|---|
| M0-01 | 開始状態・参照定義・記録の準備 | NOT_STARTED | | | |
| M0-02 | 版と実装上の初期選択を固定 | NOT_STARTED | | | |
| M0-03 | Node scripts・doctorを用意 | NOT_STARTED | | | |
| M0-04 | Tauri/Viteの空画面を成立 | NOT_STARTED | | | |
| M0-05 | mobile hostと実行環境を選定 | NOT_STARTED | | | |
| M1-01 | 共通C++とC単体試験 | NOT_STARTED | | | |
| M1-02 | Cargo workspaceとsafe FFI | NOT_STARTED | | | |
| M1-03 | Rust command・DTO・公開範囲 | NOT_STARTED | | | |
| M1-04 | TauriBackend・共通UI・self-test | NOT_STARTED | | | |
| M1-05 | mobile向け最終リンク | NOT_STARTED | | | |
| M2-01 | EmscriptenとWASM生成 | NOT_STARTED | | | |
| M2-02 | Workerのinitとheap処理 | NOT_STARTED | | | |
| M2-03 | BrowserBackendと共通UI接続 | NOT_STARTED | | | |
| M2-04 | 配信buildと2ブラウザで確認 | NOT_STARTED | | | |
| M3-01 | 入力・応答・確保失敗を検査 | NOT_STARTED | | | |
| M3-02 | 通信競合と監視期限を検査 | NOT_STARTED | | | |
| M3-03 | 破棄・再生成とUI状態を検査 | NOT_STARTED | | | |
| M3-04 | 権限・CSP・生成物分離を検査 | NOT_STARTED | | | |
| M4-01 | 採用候補と共通操作を固定 | NOT_STARTED | | | |
| M4-02 | macOS同梱アプリを検証 | NOT_STARTED | | | |
| M4-03 | iOS Simulatorで検証 | NOT_STARTED | | | |
| M4-04 | Android Emulatorで検証 | NOT_STARTED | | | |
| M4-05 | WindowsでFFIとexeを検証 | NOT_STARTED | | | |
| M4-06 | 全Webブラウザを検証 | NOT_STARTED | | | |
| M5-01 | クリーン再現とSDK独立性 | NOT_STARTED | | | |
| M5-02 | CI workflowを準備 | NOT_STARTED | | | |
| M5-03 | 全記録を監査して採用判断 | NOT_STARTED | | | |

工程順は [実装工程](../03-implementation-plan.md) に従う。reportsへコピー後はリンクを `../docs/03-implementation-plan.md` に直す。
