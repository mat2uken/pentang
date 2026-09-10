# pentang validation lab

このディレクトリは、開発者が同じ手順で Web、Tauri 同梱アプリ、Android/iOS 実機を検証するための運用入口を示す。実装は `scripts/lab.mjs`、製品シナリオは `tests/tauri/` と `docs/verification/`、端末固有の操作は既存の `scripts/verify-*-device.mjs` に置く。

## 日常の実行

Node は `.node-version` の 24.20.0 を使う。初回または依存関係を再現したいときは次を実行する。

```sh
npm run lab -- doctor --target all --phase tools
npm run lab -- setup --apply --target all
npm run lab -- targets list
```

変更を素早く確認する場合:

```sh
npm run lab -- run --profile fast
npm run lab -- run --profile affected --changed
```

プロファイルは次の順で広がる。

| profile | 実行内容 |
|---|---|
| `fast` | typecheck、API/Vitest、CMake、FFI、Tauri Rust |
| `web` | `fast` + Emscripten/Vite build + Playwright |
| `packaged` | `fast` + debug Tauri build + embedded WebDriver |
| `devices` | 明示した Android serial / iOS UDID の実機検証 |
| `affected` | 変更ファイルから `web`/`packaged`/`devices` を選択 |
| `full` | `fast` + `web` + `packaged` + 明示した実機 |

結果は `.lab-state/runs/<run-id>/run.json` と `run.md` に保存される。`.lab-state/` は Git 対象外で、同じ HEAD、作業状態、入力ハッシュ、コマンド、ログ、端末占有を一つの実行として追跡する。表示は次で行う。

```sh
npm run lab -- report --run <run-id>
npm run lab -- report --run <run-id> --json
```

## 実機

共有端末を自動選択しない。まず一覧を確認し、対象を明示する。

```sh
npm run lab -- targets list
npm run lab -- targets list --show-identifiers
npm run lab -- run --profile devices \
  --android-serial <adb-serial> \
  --ios-udid <device-udid> \
  --preview-host <LAN-address> \
  --preview-port 4174
```

Android は APK の install/launch と Chrome の LAN 到達を同じ実行で確認する。iOS は `xcrun devicectl` で Safari を対象 URL へ自動起動し、`pymobiledevice3==11.12.1` の native RSD CDP bridge で URL 一致のページを選んで操作する。初回の端末信頼、ロック解除、iOS 18 の Settings > Apps > Safari > Advanced > Web Inspector / Remote Automation の有効化だけを人が行う。以後のタブ確認、画面操作、待機、ログ保存はスクリプトが行う。端末が未接続、ロック中、URL 不到達、inspectable tab 不在の場合は `BLOCKED` として再開条件を記録する。Xcode の `devicectl` だけが対象を認識し、`pymobiledevice3` の native route が同じ実機を見つけられない場合も、画面の不具合とは扱わず接続経路の前提不足として `BLOCKED` にする。

device run は既定で自分の preview を空きポートへ起動して終了時に停止する。別プロセスの preview を使う場合だけ `--reuse-preview` を明示する。これにより古い配信を誤って検証することを防ぐ。

## シナリオの運用

1. 新しい画面や OS 操作は、まず手動または探索用 UI 操作で観測し、安定した DOM ID、IPC 呼び出し、結果文字列を特定する。
2. 再現できる API・ライフサイクルは `tests/api`、同梱 WebView は `tests/tauri`、ブラウザ配信は `docs/verification` に固定する。
3. 実機だけが持つ機能は `scripts/verify-android-device.mjs` / `scripts/verify-ios-device-web.mjs` に置き、端末 ID は引数で渡す。
4. 期待値は `[3,5,7]` と `checksum=15`、self-test `11/11`、破棄後の再初期化 `ready` のように意味のある値で確認する。スクリーンショットや OCR は補助証拠にする。
5. 失敗した run のログを残し、修正後は `resume` または新しい run を実行する。成功した別 SHA の記録を現在の修正の証拠に流用しない。

## 開発者向け実装

Tauri の embedded WebDriver は debug build にだけ登録し、`wdio-desktop` capability も desktop に限定する。`npm exec wdio run wdio.conf.mjs` は生成済み debug binary を起動し、画面の DOM と IPC 結果を確認する。release build の確認ではこの endpoint を使わず、既存の黒箱シナリオを使う。

環境自動化は再実行可能な処理に限定する。SDK の download、OS の trust、Apple signing、Android の初回認証は勝手に変更せず、doctor の不足行と手動操作をレポートする。

実装が依存する標準の接続方式は、[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)、[WebdriverIO Tauri service](https://webdriver.io/docs/desktop-testing/tauri/)、[Appium XCUITest hybrid WebView](https://appium.github.io/appium-xcuitest-driver/latest/guides/hybrid/)、[Playwright WebView2](https://playwright.dev/docs/webview2) の仕様に合わせる。現在の実機スクリプトは Android の native/Chrome と iOS Safari Web Inspector を使い、Appium/WebView2 アダプタは対象が増えた時に同じ scenario 層へ追加する。

## CI への接続

CI は `fast` を各 push、`web` と `packaged` を必要な runner label で実行する。実機は常時接続ホストで `devices` を別 job にし、lease と run artifact を保存する。実機が無い CI では `BLOCKED` を成功扱いにせず、実行しなかったことが分かる状態で報告する。
