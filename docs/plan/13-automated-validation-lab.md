# 自動検証ラボ実施計画

更新日: 2026-09-10。対象ブランチ: `feature/automated-device-validation`。

この計画は、同じ変更に対して host の試験、Web、Tauri の同梱 WebView、Android/iOS の実機を同じ入口から検証し、結果を source と生成物へ結び付けるためのもの。人が行う操作は初回の端末信頼・ロック解除・権限・接続だけに絞り、通常の画面操作、待機、結果判定、ログ保存は自動化する。

## 完了条件

- `doctor` が固定版の Node/npm、Emscripten、Rust/CMake/C++、Android SDK/JDK、Xcode、iOS inspection tool を検出する。
- `setup --apply` を何度実行しても同じ lock から依存関係を再現でき、SDK・ライセンス・署名・端末の trust 状態を勝手に変更しない。
- `fast`、`web`、`packaged`、`devices`、`full` の各 profile が同じ run 記録形式で結果を残す。
- Web は Chromium/Firefox、Tauri は debug 同梱 WebDriver、Android は現行ソースから再生成した APK の native/Chrome 経路、iPhone XS は Safari Web Inspector/CDP 経路を実際に確認する。
- PASS、FAIL、BLOCKED を区別し、端末や前提が不足した場合にだけ再開条件を示して止まる。
- 既知のシナリオは DOM ID と意味のある期待値で判定し、画像認識や座標だけに依存しない。

## 実装した構成

| 層 | 入口 | 役割 |
|---|---|---|
| host | `scripts/lab.mjs` の `fast` | typecheck、Vitest、CMake、Rust FFI、Tauri Rust |
| Web | `web` | Emscripten/WASM build、固定 preview、Playwright |
| Tauri | `packaged` | debug binary、embedded WebDriver、実 WebView の lifecycle |
| Android/iOS | `devices` | 明示 serial/UDID、端末固有スクリプト、LAN preview/Web Inspector |
| 選択 | `affected --changed` | 変更ファイルを分類し、必要な profile だけを選択 |
| 全体 | `full` | 上記を順に実行し、同一 run に保存 |

`src-tauri` の WebDriver plugin と capability は debug desktop にだけ登録する。Android build では plugin を依存に入れず、通常の mobile binary に検証 endpoint を含めない。Android NDK の API レベル付き clang++ と `llvm-ar` は `packages/ffi/build.rs` が環境変数、標準 SDK 配置、lock の API レベルから再現可能に解決する。

## 冪等なセットアップ

1. `doctor --target all --phase tools` は読み取り専用で前提を表にする。
2. `setup --apply --target all` は pinned Node の sibling npm を使い、lock・Node 版・主要依存が変わった時だけ `npm ci` を実行し、doctor の結果を `.lab-state/setup.json` に原子的に保存する。
3. SDK download、Android license、macOS trust、署名鍵、端末 unlock は自動操作しない。不足は doctor の remedy と `BLOCKED` の再開条件にする。
4. run の JSON は一時ファイルから rename して保存し、途中終了でも以前の記録を壊さない。端末 lease は run 終了時に解放する。

## シナリオの固定方法

探索段階では画面・OS 固有の挙動を観測し、固定できた経路を次の層へ移す。

- API の入力、エラー、寿命は `tests/api`。
- 同梱 WebView の DOM と IPC は `tests/tauri`。
- 配信 header、WASM、browser の結果は `docs/verification`。
- Android native/Chrome と iOS Safari Web Inspector は `scripts/verify-*-device.mjs`。

既知の画面では `#status`、`#backend-info`、`#run`、`#self-test` などの stable selector と、`[3,5,7]` / checksum 15 / self-test 11/11 / dispose・re-init の値を同時に確認する。OCR や screenshot は端末の補助証拠として保存する。失敗を探索成功として扱わず、シナリオの修正条件を run に残す。

## 日常運用

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lab -- doctor --target all --phase tools
npm run lab -- run --profile fast
npm run lab -- run --profile affected --changed
npm run lab -- run --profile full \
  --android-serial <adb-serial> \
  --preview-host <LAN-address> \
  --preview-port 4174
npm run lab -- report --run <run-id>
```

`devices` と `full` は端末を推測しない。Android serial、iOS UDID、preview host を明示する。iOS は preview 起動後に `xcrun devicectl` で Safari を対象 URL へ開き、`pymobiledevice3==11.12.1` の native RSD CDP bridge が URL 一致のページを選ぶため、通常は URL を人が入力しない。初回の端末信頼、ロック解除、Web Inspector / Remote Automation の設定だけが人の前提である。接続なし、ロック中、URL 不到達、tab 不在は `BLOCKED` として記録する。

device run は既定で空きポートに自分の preview を起動し、終了時に停止する。既存の配信を使う場合だけ `--reuse-preview` を付ける。

## 証拠と再実行

各 run は `.lab-state/runs/<run-id>/run.json` と `run.md` に branch、HEAD、dirty 状態、source hash、profile、実コマンド、PID、時間、ログ、生成物 hash、端末 lease、手動前提を保存する。`.lab-state/` は Git 対象外にして、個人 path や端末識別子を共有文書へ持ち込まない。中断時は `cancel` で process と service を止め、ログを確認してから `resume` または新しい run を開始する。

## 実施結果と残作業

同一作業状態で `full` を実行し、run `20260910112322-1b27f924` は次を PASS とした。

- typecheck、API 163件、CMake core、Rust FFI、Tauri app tests
- Emscripten/WASM build と Chromium/Firefox Playwright 4件
- debug Tauri build と embedded WebDriver の実 WebView lifecycle
- 現行ソースから生成した Android APK の install/launch、native、Chrome、`[3,5,7]` / 15、11/11、dispose、re-init

preview の所有方式と数字の境界を考慮した期待値判定、iOS の CoreDevice UUID→hardware UDID 解決、native CDP の URL一致選択を実装した。現行作業状態の `devices` profile で Xperia XQ-DQ44 と iPhone XS を同じ run から再検証した。Xperia は現行ソースから APK を再生成して native/Chrome、`[3,5,7]` / 15、self-test 11/11、dispose・re-init、W-02 を PASS、iPhone XS は `devicectl` による Safari URL起動、URL一致の単一ページ、native RSD CDP、同じ UI-01〜05 と W-02 を PASS、終了時に preview と lease を回収した。各 run の ID と詳細は `.lab-state/runs/<run-id>/run.md` または `npm run lab -- report` で確認でき、APK の SHA-256 は `4a0b307ac33f2718fac3e7c92e282b32d9b82df04649f864a36fe7ada2a31342` である。

iPhone XS の初回 run は旧 pymobiledevice3 の接続経路で `BLOCKED` だったが、pymobiledevice3 11.12.1 の native RSD と CoreDevice の hardware UDID 解決を追加して解消した。現行の devices run で両実機を PASS として記録している。Windows runner、release build の黒箱検証、接続端末の定期実行は後続である。
