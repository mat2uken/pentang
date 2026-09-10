# 実装レポート (M5-03 監査) — v1.2

- 判定: **一部検証完了** (初回PoC完了ではない。mobileはSim/Emuと明記。実機や性能まで認定しない)
- 採用source: 未commitのためfile hash識別 (local/m4-01/run.md)。HEAD de87224 + untracked実装。commit/pushは別依頼待ち
- 計画版: docs v1.2、27ステップ

## 必須9行の結果

| ID | 結果 | run |
|---|---|---|
| N-MAC | PASS | local/nmac-m4-02/run.md UI-01〜06 |
| N-IOS-SIM | PASS | local/ios-sim-m4-03/run.md (UI-03はself-test内basicで代替) |
| N-ANDROID-EMU | PASS | local/emu-m4-04/run.md UI-01〜06 |
| N-WIN | BLOCKED | Windows 11ホスト未選定 (O5)。再開条件: 利用先・担当確保後にM4-05手順 |
| W-CHROMIUM | PASS | root/subpath別build・別run Playwright chromium 2+2 |
| W-FIREFOX | PASS | root/subpath別build・別run Playwright firefox 2+2 (155.0) |
| W-SAFARI | PASS | local/wsafari-root/subpath/run.md 実Safari 26.6.2 AppleScript全自動 |
| W-IOS | PARTIAL | local/sim-safari-wios: UI-01/UI-02+W-02 PASS (openurl+screenshot+OCR全自動)。UI-03〜05はcliclick mapping不安定で要再試行。スクリプトverify-sim-safari.mjsは全自動・証拠付き |
| W-ANDROID | PASS | local/emu-chrome-wandroid/run.md verify-emu-chrome.mjs全自動 UI-01〜05+W-02 (Emu Chrome 152、10.0.2.2:4173) |

後続2行:

| ID | 結果 | 次操作 |
|---|---|---|
| N-IOS-DEVICE | NOT_RUN | 初回はSim先行。署名・provisioning後にdevicectlで対応 |
| N-ANDROID-DEVICE | BLOCKED | local/android-device/BLOCKED.md。verify-android-device.mjsで全自動化済み。実機ロック中のため解除後に `npm run verify:android-device -- --serial <adb-serial> --preview-host <host-lan-ip>` で再実行 (シリアル・IPは記録省略) |

## 必須共通試験 (22試験ID)

- PASS: C-01、C-02、C-03、C-04、A-01、A-02、A-03、A-04、N-01、W-01、W-02、W-03、L-01、L-02、L-03、L-04、P-01、S-01、S-02 (19件)。詳細はverification-matrix.md
- IN_PROGRESS: R-01 (別コピーunit再現PASS、対象build再現残り)、R-02 (実体環境なし、PATH遮断は補助)、R-03 (本レポートで監査中)

## 指摘対応 (../plan/11-review-traceability 12件)

- 文書対応済みを実動作確認済みへ自動変更しない。本レポートのPASSはすべて実測 (unit 136 + e2e + 実機UI + header fetch + screenshot/xml) に基づく。
- test用export (worker __setImporter/__attach/__reset、browser buildUrls、request-state整理) は製品動作変更なし。typecheck all + 136 PASS + Web e2e再PASSで回帰確認。
- 共有source修正後の古い成功の合算なし: 今回の修正後にtest:api/typecheck/Web e2eを再実行し、新runで記録。旧run (nmac/ios-sim/emuのN系) はC++/ABI無変更のため履歴として維持。

## 未完了項目 (理由・担当・次コマンド)

1. N-WIN BLOCKED: Windows 11ホスト未選定。担当: 要確保。次: M4-05手順 (npm ci → doctor → test:core → cargo FFI → tauri build → exe UI-01〜06)
2. W-IOS UI-03〜05: Sim Safari tap mapping不安定。担当: 要再試行。次: `node scripts/verify-sim-safari.mjs --url http://<host-lan-ip>:4174/ --out docs/reports/local/sim-safari-wios` (openurl+screenshot+OCRはPASS済み、tap座標をgrid探索で再調整)
3. R-02 SDK独立性: 実体環境なし。担当: 要host/container確保。次: M5-01手順 (native-onlyでcargo/tauri、web-onlyでemsdk/vite)
4. 実機 (Androidロック、iOS署名): 解除・provisioning後に `npm run verify:android-device` / devicectlで対応。スクリプトは全自動化済み
5. 非許可window実拒否: 設定 + 分離で代替済み。実拒否操作は残課題として別途

## 次の作業 (一意に追える)

- `npm run test:coverage` 95.87/90.06/95.96/97% 維持 ( thresholds 90 )
- `node scripts/verify-emu-chrome.mjs` でW-ANDROID回帰 (ログイン済みEmu、前提: preview :4173 base /)
- `node scripts/verify-desktop-safari.mjs` でW-SAFARI回帰 (root :4173、subpath :4175/poc/)
- Sim Safari taps再試行 + 実機解除後verify + Windows host確保後にM5-03再監査で初回PoC完了を判定
- commit/pushや公開は自動実施しない (別依頼待ち)
