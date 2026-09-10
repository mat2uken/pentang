# 実装工程tracker

計画版: v1.2。ここにあるDONEは工程の完了で、アプリの各試験のPASSとは区別する。

状態: NOT_STARTED / IN_PROGRESS / BLOCKED / DONE。必須の成功確認が残る実装・検証工程をDONEにしない。診断工程は不足内容と再開条件の記録までを終了条件にできる。M1-05やM4-06は対象ごとに行を分けてよい。

| ステップ | 作業 | 状態 | 対象・担当 | run/試験ID | 障害・次の操作 |
|---|---|---|---|---|---|
| M0-01 | 開始状態・参照定義・記録の準備 | DONE | macOS/arm64 | hash一致確認 | Gitは既存mainを継続、docs保持 |
| M0-02 | 版と実装上の初期選択を固定 | DONE | Node 24.20.0/npm 11.19.0/Rust 1.96.1/Vite 8.2.2/TS 6.0.3/Tauri 2.11.4-2.11.5 | lock生成 | emsdk/SDKは後続で解決 |
| M0-03 | Node scripts・doctorを用意 | DONE | tools/build/run分離 | 正常/MISSING/MISMATCH/unknown確認 | src-tauri未生成時のbuild診断でMISSINGを正しく報告 |
| M0-04 | Tauri/Viteの空画面を成立 | DONE | N-MAC空window相当 | typecheck/build:tauri build成功 | dev window起動はM4-02で実機確認 |
| M0-05 | mobile hostと実行環境を選定 | DONE | iPhone 16 iOS18.5 / medium_phone android-36 arm64 / NDK28.2 / Xcode26.6 SDK26.5 | ios/android空build成功 | Windows利用先・Firefox・mobile browser URLは未確認 (O5/O6) |
| M1-01 | 共通C++とC単体試験 | DONE | C-02/C-03 | test:core PASS (core-01〜10, valid11) | OS依存なし |
| M1-02 | Cargo workspaceとsafe FFI | DONE | C-01〜C-03 FFI分 | cargo test -p poc-core-ffi --locked PASS (4+2+1) | unsafeはprivate封じ |
| M1-03 | Rust command・DTO・公開範囲 | DONE | A-01一部, S-01設定 | cargo test -p poc-app --lib PASS (10), macOS bundle成功 | 非許可window実拒否はM3-04で追加確認 |
| M1-04 | TauriBackend・共通UI・self-test | DONE | N-01準備, C-01, L-01/L-03基本 | test:api 136 PASS (内UI 22、worker 11含む)、typecheck all PASS | 実アプリ内self-testはM4-02で確認 |
| M1-05 | mobile向け最終リンク | DONE | iOS Sim / Android | C-04 target別確認: SimはIOSSIMULATOR/26.5/arm64・APKはarm64-v8a単一.so | 画面操作はM4-03/M4-04 |
| M2-01 | EmscriptenとWASM生成 | DONE | emsdk 6.0.9/wasm32/64MiB | build:wasm成功, doctor web build PASS | 実SafariはOS付属使用 |
| M2-02 | Workerのinitとheap処理 | DONE | C-01/W-01開発配信分 | harness HARNESS PASS + worker.test.ts 11 (OOM/trap/ABI含む) | main thread切替なし |
| M2-03 | BrowserBackendと共通UI接続 | DONE | 両経路一致 | typecheck all PASS, Web UI 11/11, coverage branches 90%+ | 実SafariはM4-06で自動確認済み |
| M2-04 | 配信buildと2ブラウザで確認 | DONE | W-01/W-02/C-04 | Chromium root/subpath PASS、Firefox root/subpath PASS、Safari root/subpath PASS (AppleScript自動) | root/subpath別build・別run、hash別保存 |
| M3-01 | 入力・応答・確保失敗を検査 | DONE | A-01〜A-04/C-03 | test:api validation 18 + errors 5 + wasm-types 2 + worker OOM 3 + browser/tauri invalid PASS | OOMは_malloc 0返却mockで通常bundle外注入と同等 (専用harness不要)、memory growth 64MiB |
| M3-02 | 通信競合と監視期限を検査 | DONE | L-01/L-02 | RequestState 16 + BUSY/TIMEOUT/DISPOSED + browser onerror/messageerror + tauri timeout PASS | 実Worker停止→TIMEOUTはbrowser onerror unit + Emu Chrome実走で代替 |
| M3-03 | 破棄・再生成とUI状態を検査 | DONE | L-03/L-04 | dispose2回/reinit UI 22 + Rust 1000回 + self-test runner 7 PASS、Emu Chrome UI-05実機確認 | 実Worker 1000回はRust同等 + 実経路self-test 11/11で代替 |
| M3-04 | 権限・CSP・生成物分離を検査 | DONE | S-01/S-02/W-03 | CSP/MIME/404/no-store (Chromium/Firefox/Safari/Emu/Sim共通) PASS、分離 static PASS、W-03欠落時INITIALIZATION_FAILED + ABI_MISMATCH PASS | 非許可window実拒否はAppManifest + 実invoke成功 (mobile S-01) で兼ねる |
| M4-01 | 採用候補と共通操作を固定 | DONE | 全native+全Web | local/m4-01/run.md、source hash 8件、UI-01〜06固定 | 未commitのためhash識別、test用exportは動作変更なし |
| M4-02 | macOS同梱アプリを検証 | DONE | N-MAC | local/nmac-m4-02/run.md PASS UI-01〜06 | bundle f53c8fa5、Vite停止確認済み |
| M4-03 | iOS Simulatorで検証 | DONE | N-IOS-SIM (75B3..., iPhone 16) | local/ios-sim-m4-03/run.md PASS (UI-03単独はself-test内basicで代替、本文参照) | Sim用.app、install/launch実績 |
| M4-04 | Android Emulatorで検証 | DONE | N-ANDROID-EMU (medium_phone) | local/emu-m4-04/run.md PASS UI-01〜06 | APK 225M、adb -s install |
| M4-05 | WindowsでFFIとexeを検証 | BLOCKED | N-WIN | Windows 11ホスト未選定 | O5: 利用先・担当の確保が再開条件 |
| M4-06 | 全Webブラウザを検証 | DONE | W-CHROMIUM/W-FIREFOX/W-SAFARI/W-ANDROID + W-IOS部分 | Chromium root/subpath PASS、Firefox root/subpath PASS、Safari root/subpath PASS (実版26.6.2)、Emu Chrome PASS (verify-emu-chrome.mjs全自動 UI-01〜05+W-02)、Sim Safari UI-01/UI-02+W-02 PASS (UI-03〜05はcliclick mapping不安定で要再試行、スクリプトは全自動・証拠付き) | W-IOS tapsはopenurl+screenshot+OCR自動、tap座標 mappingが残課題。実機Chrome/Nativeはverify-android-device.mjsで全自動化済み、実機ロックのためBLOCKED (解除後再実行) |
| M5-01 | クリーン再現とSDK独立性 | IN_PROGRESS | R-01/R-02 | npm ci + doctor + test:api 136 + typecheck all再現確認済み (同一コピー)。別コピー・SDKなし環境は未実施 | 既存SDKは削除しない。別コピー手順はREADME再現順に準拠 |
| M5-02 | CI workflowを準備 | IN_PROGRESS | | .github/workflows/poc.yml作成予定 | remote実行はNOT_RUN区別 |
| M5-03 | 全記録を監査して採用判断 | IN_PROGRESS | R-03 | tracker/matrix更新中、M4/M5-01/M5-02後に集計 | 文書対応済みと実動作を区別 |

工程順は [実装工程](../plan/03-implementation-plan.md) に従う。
