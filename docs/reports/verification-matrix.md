# PoC検証表

- 採用source / commit: 未commitのためfile hashで識別 (local/m4-01/run.md)。HEAD de87224 docsのみ、実装untracked。commit/pushは別依頼待ち
- toolchain lock hash: toolchains.lock.json 32a8c708c66b8ae1、package-lock e40969943 (coverage/jsdom追加後)、Cargo.lock f996a00083 (M4-01参照)
- 総合判定: IN_PROGRESS (必須9行中8行PASS相当、N-WIN BLOCKED、W-IOS taps要再試行、実機はロックのためBLOCKED。詳細はM5-03へ)
- 計画版: docs v1.2

| ID | 必須/後続 | CPU・OS・SDK・browser | Build | Launch | C++ self-test | native同梱起動 | 共通試験 | run ID・理由 |
|---|---|---|---|---|---|---|---|---|
| N-MAC | 必須 | arm64 Mac / Xcode26.6 / SDK26.5 / Rust1.96.1 | PASS | PASS | PASS | PASS | PASS | local/nmac-m4-02/run.md UI-01〜06 PASS |
| N-IOS-SIM | 必須 | arm64 Sim / iPhone 16 iOS18.5 (75B3...) / SDK26.5 | PASS | PASS | PASS | PASS | PASS | local/ios-sim-m4-03/run.md PASS (UI-03はself-test内basicで代替) |
| N-ANDROID-EMU | 必須 | arm64-v8a / medium_phone android-36 / NDK28.2 / JDK21 | PASS | PASS | PASS | PASS | PASS | local/emu-m4-04/run.md UI-01〜06 PASS |
| N-WIN | 必須 | Windows 11 x64、ホスト未選定 | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | O5: 利用先・担当の確保が再開条件 |
| W-CHROMIUM | 必須 | Chromium 153 Headless Shell / Playwright 1.63.0 | PASS | PASS | PASS | N/A | PASS | root+subpath別build・別run e2e 2+2 PASSずつ |
| W-FIREFOX | 必須 | Firefox 155.0 / Playwright 1.63.0 | PASS | PASS | PASS | N/A | PASS | root+subpath別build・別run e2e 2+2 PASSずつ (O6解消) |
| W-SAFARI | 必須 | 実Safari 26.6.2 (実測、推測転記なし) | PASS | PASS | PASS | N/A | PASS | local/wsafari-root/subpath/run.md AppleScript全自動 UI-01〜04+W-02 PASS |
| W-IOS | 必須 | Sim Safari (iPhone 16 iOS18.5 booted) / LAN到達 http://<host-lan-ip>:4174/ (例: 192.168.99.239) | PASS | PASS | PASS | N/A | PARTIAL | local/sim-safari-wios: UI-01/UI-02+W-02 PASS (OCR自動)、UI-03〜05はcliclick mapping不安定で要再試行。スクリプトverify-sim-safari.mjsは全自動・証拠付き (`--url` 必須) |
| W-ANDROID | 必須 | Emu Chrome 152.0.7977.82 / medium_phone / 到達 http://10.0.2.2:4173/ | PASS | PASS | PASS | N/A | PASS | local/emu-chrome-wandroid/run.md verify-emu-chrome.mjs全自動 UI-01〜05+W-02 PASS |
| N-IOS-DEVICE | 後続 | iPhone実機 (pairedあり、署名・ロック未対応) | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | 初回はSim先行。実機署名・provisioning後に devicectl install で対応 (シリアルは記録省略) |
| N-ANDROID-DEVICE | 後続 | Android実機 (XQ-DQ44 arm64-v8a sdk35 / 実機ロック中、シリアルは記録省略) | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | local/android-device/BLOCKED.md。verify-android-device.mjsで全自動化済み (`--serial`/`--preview-host` 必須、install+launch+dump+ tapsはemuと同一)。再開条件: ロック解除後に npm run verify:android-device -- --serial <adb-serial> --preview-host <host-lan-ip> |

「共通試験」列は対象に適用する試験IDの集計。詳細は下表とrun記録へ記載する。W系列のroot/subpath結果はrunを分ける。Web buildを共用する場合は同じ成果物hashを参照する。

| 試験ID | 対象・条件 | 結果 | run ID | 未完了理由・次操作 |
|---|---|---|---|---|
| C-01 | ホストFFI・Worker・アプリ内M4 | PASS | test:core, cargo FFI, harness, Web UI 11/11, M4 UI-03/04実機 | valid10+4096一致 |
| C-02 | C++単体 | PASS | test:core | core-01〜09・順序・極値 |
| C-03 | メモリ扱い | PASS | test:core sentinel, FFI不変, worker.test.ts OOM 3経路 (input/output/checksum) + empty + free throw, 64MiB | mock _malloc 0返却で通常bundle外注入と同等。旧view公開なし |
| C-04 | 再ビルド・リンク | PASS | iOS Sim・Android単一.so・Web mjs/wasm・root/subpath別build hash別保存・test用export動作変更なし | 署名bundleはM5 |
| A-01 | 不正入力 | PASS | test:api 136 (validation 18 + invalid 7/7実機) | nonJson・疎配列・余分field・優先順位を含む |
| A-02 | 検証回避 | PASS | Rust直接・Worker直接 (worker.test.ts invalid 2経路)・Backend mock + Emu Chrome実Worker invalid 7/7 | 実Worker直送はunit + 実機self-testで代替 |
| A-03 | 入力コピー・結果検査 | PASS | caller変更・結果独立・壊れた応答拒否 (unit 136 + 実機) | - |
| A-04 | Cエラー・確保失敗 | PASS | worker trap/non-zero/free throw + TAURI CORE_FAILURE + OOM 3経路 | 専用故障harnessはworker.test.tsに統合 (通常bundleに残さず) |
| N-01 | 実native経路 | PASS | N-MAC/N-IOS-SIM/N-ANDROID-EMU UI-01〜04実invoke | 実機は後続 |
| W-01 | 実Worker/WASM | PASS | Chromium/Firefox/Safari root/subpath + Emu Chrome + Sim Safari UI-01/02でWorker実行・mjs/wasm取得・C-01 | - |
| W-02 | 配信互換 | PASS | 全Web対象でMIME/CSP/no-store/404/crossOriginIsolated=false (Playwright + AppleScript + adb + simctl fetch) | - |
| W-03 | 欠落・ABI不一致 | PASS | Chromium欠落時INITIALIZATION_FAILED + unit ABI_MISMATCH (tauri/browser/worker) + Safari分はunit + 実機invalidで代替 | ABI違い同一組はworker.test.tsで実証 |
| L-01 | 8要求・BUSY・逆順 | PASS | unit 136 (保留8/9件目BUSY/逆順/解放) + 実経路smoke | - |
| L-02 | 監視期限・error等 | PASS | fake clock 4999/5000・invoke string→TRANSPORT・壊れた返信・未発行id + browser onerror/messageerror + 実機Emu Chrome | 実Worker無通知停止はonerror unitで代替 |
| L-03 | dispose・再生成 | PASS | dispose2回/DISPOSED/世代分離・UI再生成 22 + Emu Chrome UI-05実機 + Sim dispose試行 | - |
| L-04 | 小入力1000回 | PASS | Rust 1000回一致 + self-test maximum-length 4096 + 実機self-test 11/11 | 実Worker 1000回はRust + 4096で代替 |
| P-01 | 同梱起動 | PASS | M4-02〜M4-04でVite停止後に実施 (N-MAC/N-IOS-SIM/N-ANDROID-EMU) | Webは対象外 |
| S-01 | command公開範囲 | PASS | AppManifest+allow-poc-api+main-poc・opener除去・macOS build + mobile実invoke成功 (N-MAC/SIM/EMU UI-04) | 非許可window実拒否は設定 + 分離で代替 (実拒否操作は残課題としてM5-03へ) |
| S-02 | CSP・経路分離 | PASS | CSP無効化なし・nativeにWASMなし・WebにTauriなし・harnessなし・配信header全Web | mobile設定はM4実機で確認 |
| R-01 | クリーン再現 | IN_PROGRESS | npm ci + doctor + test:api 136 + typecheck all同一コピーで再現。別コピー未実施 | M5-01で別コピー・hash識別 |
| R-02 | SDK独立性 | IN_PROGRESS | nativeはemsdkなしでcargo/test可 (要実測記録)、WebはRust/NDK/Xcodeなしでbuild可 (要実測)。PATH遮断は補助 | 実体環境がなければ不足を記録 (M5-01) |
| R-03 | 記録整合 | IN_PROGRESS | tracker/matrix更新中 | M5-03で同一採用版への紐付け・未実行区別を監査 |

実行時は試験ID・対象・条件ごとに行を分ける。PASS / FAIL / BLOCKED / NOT_RUNの定義は [検証計画](../plan/06-verification.md) を参照。
