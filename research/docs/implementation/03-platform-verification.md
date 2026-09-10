# 実装手順3 — M4の環境別確認とM5の採用判断

[工程一覧](../03-implementation-plan.md)に戻る。M4の各OSは個別に進められる。異なるtargetの障害を理由に、準備ができた行まで止めない。

<a id="m4-01"></a>
## M4-01 — 採用候補と共通操作を固定

**依存:** M3-04。**編集先:** reportsのrun記録、source/成果物の一覧、root README。通常アプリに追加機能は作らない。

1. 対象sourceを識別する。commit済みならSHAとdirty、未commitならsource/config/lockの相対path一覧とSHA-256を記録する。
2. toolchain lock、API/header/fixture、Tauri設定、ビルド用scriptのhashを記録する。test用差分が通常buildに残っていないことを確認する。
3. 各成果物は別run IDで保存し、build日時・target・profile・base URLを記録する。作業途中でshared sourceを修正したら影響する行を新runで試す。
4. 全nativeと全Webで次の共通操作を使う。API拒否試験件数とC++計算成功11件を分ける。

| 操作番号 | 操作 | 期待 |
|---|---|---|
| UI-01 | 起動してreadyを待つ | 失敗時はcode/message。通常の監視期限内で終了 |
| UI-02 | getInfoを表示 | nativeは対象OS/tauri-native/native-ffi、Webはbrowser/wasm-worker/dedicated-worker、実core ABI=1/version=0.1.0 |
| UI-03 | `[1,2,3]`, 2, 1を実行 | `[3,5,7]`、checksum=15 |
| UI-04 | 共通self-test | 成功計算11件、期待する入力拒否も全件一致 |
| UI-05 | 破棄→再初期化→同じ計算 | disposed→ready、旧結果の上書きなし |
| UI-06 | nativeを終了して再起動 | Vite停止状態の同じ同梱成果物でUI-02〜UI-04成功 |

**確認:** 必須9行、採用候補、共通操作が記録可能。**失敗時:** source/設定/成果物の対応が曖昧なら先に識別をやり直す。**終了:** 各OSに同じ検査内容を渡せる。識別子の一致はバイナリのbyte完全一致を要求する意味ではない。

<a id="m4-02"></a>
## M4-02 — macOSの同梱起動

**依存:** M4-01。**対象:** N-MAC。

1. 固定Nodeへ切り替え、`npm ci`、native build診断、FFI試験、Tauri buildを順に実行する。
2. 今回のbuildが出した.appと実行binaryのpath/hash、bundle ID、CPUを保存する。
3. この作業で起動したViteだけを停止し、.appをFinderまたはopenから起動する。別作業のサーバをまとめて終了しない。
4. UI-01〜UI-06を実施し、画面とログをrunへ保存する。WebView情報は取得できたOS/WebKit情報を記録し、Safari版を推測転記しない。

```sh
npm run doctor -- --target native --phase build
cargo test -p poc-core-ffi --locked
npm run tauri -- build --debug --target aarch64-apple-darwin --bundles app
```

**確認:** N-01/P-01、C-01。**失敗時:** .appの取り違え、frontendDist、devUrl依存、実FFIリンクを確認。**終了:** N-MACの該当列PASS。dev windowだけ成功した状態は終了しない。

<a id="m4-03"></a>
## M4-03 — iOS Simulator

**依存:** M4-01とM1-05のiOS側成功。**対象:** N-IOS-SIM。

1. M0で選んだruntime/機種のUDIDを確認し、必要ならそのSimulatorだけ起動する。build対象は `aarch64-apple-ios-sim`。
2. iOS build診断後、TauriでSimulator用.appを生成する。`.ipa`や実機用arm64.appを代用しない。
3. .appのbundle IDとSimulator向けであることを確認し、指定UDIDへinstall/launchする。
4. Vite停止状態でUI-01〜UI-06を行う。録画/画面/ログを取得し、端末用証拠とは別にする。

```sh
npm run doctor -- --target ios --phase build --device-class simulator --arch arm64
npm run tauri -- ios build --debug --target aarch64-sim
xcrun simctl install <UDID> <SIM_APP_PATH>
xcrun simctl launch <UDID> <BUNDLE_ID>
```

**確認:** N-01/P-01/C-01とmobileでのS-01、Simulator用成果物と画面の対応。**失敗時:** CLI help、Sim SDK、生成project、object platform、deployment target、署名要求の順で切り分ける。CLIの出力先を推測せず、必要なら生成Xcode projectの一覧/設定を読んで対象を確定する。**終了:** N-IOS-SIMのみPASS。iOS実機行は更新しない。

<a id="m4-04"></a>
## M4-04 — Android Emulator

**依存:** M4-01とM1-05のAndroid側成功。**対象:** N-ANDROID-EMU。

1. AVD名/API/ABI/serialを確認し、今回使うEmulatorを明示する。インストールは常に `adb -s` を用いる。
2. Android build診断後、AVDに合うAPKを生成する。aarch64の例をx86_64 AVDに使わない。
3. APKのpackage ID、ABI、同梱.soとC++ runtime依存を確認し、指定serialへinstallする。
4. Viteを停止してホームから起動しUI-01〜UI-06を行う。逆向きport転送等の開発接続に依存せず同梱UIが動くことを確認する。

```sh
npm run doctor -- --target android --phase build --arch arm64
npm run tauri -- android build --debug --apk --target aarch64
adb -s <SERIAL> install -r <APK_PATH>
```

**確認:** N-01/P-01/C-01とmobileでのS-01、APK/AVD/画面の対応。**失敗時:** ABI/API→NDK compiler/sysroot→runtime→mobile entry/command→frontendDistの順で確認。**終了:** N-ANDROID-EMUのみPASS。Android実機行は未着手のまま。

<a id="m4-05"></a>
## M4-05 — WindowsのFFIとexe

**依存:** M4-01、利用可能なWindowsホスト。**対象:** N-WIN。

1. [08の引き継ぎ情報](../08-handoff.md)を渡し、Windows側でsourceの一致と既存変更を確認する。別セッションへの実行依頼はその時点のユーザー指示に従う。
2. Windows 11 x64、MSVC C++ Build Tools、Windows SDK、WebView2、固定Rust/Nodeを診断する。Developer PowerShell等の適切な環境を使う。
3. C++/FFIとRust commandの試験後、同じsourceからexeを生成する。MinGW製archiveを混在させない。
4. Viteを停止し、生成exeを直接起動してUI-01〜UI-06を行う。起動exeのhashとWebView2実版を記録する。

```powershell
npm ci
npm run doctor -- --target native --phase build
npm run test:core
cargo test -p poc-core-ffi --locked
cargo test -p poc-app --lib --locked
npm run tauri -- build --debug --no-bundle --target x86_64-pc-windows-msvc
```

**確認:** C-01〜C-04のWindows適用分とN-01/P-01、実exe/画面/WebView2版。**失敗時:** ツール不足とcompile/linkとWebView起動を分ける。**終了:** 実WindowsセッションでN-WINの該当列PASS。Windowsが使えない場合はBLOCKEDと次操作を記録し、他行の作業を続ける。

<a id="m4-06"></a>
## M4-06 — 全Webブラウザの確認

**依存:** M4-01、M0-05のbrowser/実行先選定。**対象:** W-CHROMIUM/W-FIREFOX/W-SAFARI/W-IOS/W-ANDROID。

1. 同一sourceからrootとsubpathの2つの配信buildを別々に生成・保存する。各browserが読むファイルのhashを記録する。
2. Chromium/FirefoxはPlaywrightの実browserを使用できる。付属版かインストール済み版かと実版を記録する。SafariはmacOSの実Safariを使う。
3. iOS Simulator内Safari、Android Emulator内Chromeから到達するURLを確認する。desktop browserのviewport変更をmobile browser行の代わりにしない。
4. Simはまずホストのloopbackへの到達を確認し、Android標準Emulatorはホスト到達用アドレスを実ネットワークで確認する。必要な場合だけpreviewを特定の到達可能hostへbindし、試験後に停止する。
5. 5browserそれぞれでrootとsubpathからUI-01〜UI-05、MIME/CSP/404/Worker/WASM/crossOriginIsolatedを確認する。負例W-03は少なくともChromiumと実Safariで行う。
6. Playwright WebKitやmobile viewportを追加試験に使った場合は別行に記録し、必須行を置き換えない。

**確認:** W-01/W-02の10組、指定browserのW-03。**失敗時:** 実URL→HTTP応答→Worker→factory→C++の順で確認。**終了:** 5つのWeb行が各条件でPASS。Webのoffline再起動は試験しない。

<a id="m5-01"></a>
## M5-01 — クリーン再現とSDK独立性

**依存:** M4-01。環境別結果が揃う前でも準備可能。**編集先:** README、再現手順、reports。

1. 採用sourceを新しい作業コピーへ用意し、生成物や別runのmjs/wasmを持ち込まない。Node切替→npm ci→対象doctor→test/buildの順をREADMEだけで再現する。
2. nativeはemsdkを使えない環境、WebはRust/NDK/Xcodeを持たない環境で最終buildする。既存の独立ホストや利用可能なcontainerを優先し、この検査のためにSDKを削除しない。
3. PATHだけでコマンドを隠す試験は補助確認とする。SDK実体や生成済み成果物への依存が残り得る場合は、それだけでR-02をPASSにしない。実施できる環境がなければ不足を記録する。
4. 元のrunとsource/設定/lockが一致することを確認し、新たな成果物hashと同じ計算結果を記録する。署名・timestampを含むbundleのbyte完全一致は要求しない。
5. source変更反映のC-04をM1/M2の記録から確認する。未実施や結果不足の場合だけ別作業コピーで補い、採用sourceに一時変更を残さない。

**確認:** R-01/R-02、同じ採用sourceへの追跡。**失敗時:** lock、PATH、生成物、隠れたinstall hookを調べる。**終了:** 再現の成功範囲と未確認を明確にできる。R-02の必須分が残る間は全体未完了。

<a id="m5-02"></a>
## M5-02 — CI workflowを準備

**依存:** M3-04。**編集先:** `.github/workflows/`、README、toolchain記録。

1. web、desktop(Windows/macOS)、android、iosのjobを分ける。共通の全target install jobを作らない。
2. 同じnpm scriptsと固定版を使い、npm ci / Cargo --lockedを基準にする。cacheはtarget・toolchain・lockで分け、失敗時に別版へ自動変更しない。
3. webは実Worker/WASMのbrowser試験、desktopはFFIと最終build、mobileは対象成果物のbuildまでを自動化する。GUI/端末の手動runは別記録にする。
4. runner OS/CPUとiOS targetを一致させる。署名秘密が必要な実機jobは初回対象に加えない。
5. action参照とworkflowを確認する。remoteを用意していない場合はworkflow準備のみ完了とし、CI実行をNOT_RUNとする。

**確認:** 設定内容、実行できるjobのログと成果物。**失敗時:** job固有の前提だけを修正し、continue-on-errorで隠さない。**終了:** CI設定と実行済み範囲を区別して報告できる。

<a id="m5-03"></a>
## M5-03 — 全記録を監査して採用判断

**依存:** M4各行、M5-01、M5-02。**編集先:** matrix、`../../reports/implementation-report.md`、最終README。

1. 必須9行・後続2行が残っていること、各runのsource/profile/targetと成果物が対応することを確認する。
2. [06の22試験ID](../06-verification.md)に実行対象・結果・run参照があり、失敗や未実行を成功へ集計していないことを確認する。
3. [11の指摘対応表](../11-review-traceability.md)を使い、12件の文書対処に対する実装側の確認結果も対応付ける。文書対応済みを実動作確認済みへ自動変更しない。
4. shared source修正後の古い成功を合算しない。再試験が必要なら影響する行を新runで行い、旧runは履歴として残す。
5. 次の判定を出し、未完了項目には理由・担当・次コマンドを書く。

| 判定 | 条件 | 報告する内容 |
|---|---|---|
| 初回PoC完了 | 必須9行と必須共通試験が採用sourceでPASS | mobileはSim/Emuと明記。実機や性能まで認定しない |
| 一部検証完了 | Windows、browser、SDK独立性等が未実施 | 完了した対象、未完了の試験ID、再開条件 |
| 構成の再検討が必要 | 共通C++や同じUIを維持できない等の実測失敗 | 最小再現、原因、代案と影響。独自host等への変更は別判断 |

**確認:** R-03、全必須対象と試験の対応、未実行/失敗の集計、文書対処と実動作の区別。**失敗時:** 不足したrun、source不一致、再試験漏れを担当ステップへ戻し、証拠を補うまで全体完了にしない。**終了:** 実測に基づく結論と次の作業が一意に追える。commit/pushや公開を自動実施しない。
