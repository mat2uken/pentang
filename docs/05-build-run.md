# 05. ビルド・起動の実装仕様

**以下は完成時のコマンド仕様であり、現時点では実行できない。** 導入順は [詳細手順](03-implementation-plan.md) に従う。M0の空画面はVite単独で確認し、まだ存在しないC++/emsdkを使うbuild:webを呼ばない。M0で採用したCLIのhelpと照合し、実在する出力pathを記録する。placeholderをそのまま実行しない。

## npm scripts

| script | 入力・動作 | 依存・結果 |
|---|---|---|
| `doctor -- --target ... --phase ...` | tools/build/run別の読み取り診断。既定build | [01](01-environment.md) の項目、不足時非0 |
| `dev:web` | WASM生成→Vite mode web | emsdk、開発HTTP URL |
| `build:wasm` | 同一C++→mjs/wasm | emsdk、`web-public/wasm/` |
| `build:web -- --base /poc/` | 型検査、WASM生成、Vite web buildを順次実行 | base省略時 `/`、`dist/web/`、配信条件を記録 |
| `preview:web -- --base /poc/ --port 4173` | dist/webを指定prefixで静的配信 | base省略時 `/`、既定hostは127.0.0.1 |
| `dev:native-ui` | Vite mode tauri、1420 strictPort | emsdk不要、Tauri dev hook用 |
| `build:native-ui` | native/node型検査、Vite tauri build | emsdk不要、`dist/native/` |
| `tauri -- ...` | ローカル固定版CLI | target別Tauri build/dev |
| `typecheck -- --scope native` | native/web/allから選択。完成時の既定all | WASM生成物なしで成功、test型も独立設定 |
| `test:core` | CMake configure/build/CTest | ホストC++ compiler、CMake |
| `test:api` | 専用configで `vitest run`。watchしない | Node、固定Vitest。実経路の証明は別試験 |
| `test:web -- --project chromium` | build済みWebをPlaywright Testで試験 | project省略時chromium。FirefoxはM4追加、実Safariは別試験 |

初回lock作成は `npm install`、以後は `npm ci`。Webにもnativeにも無関係なSDKをinstall/postinstallで要求しない。コマンド引数はNodeの配列で渡し、shell固有のrm/cp/export連鎖を避ける。`build:web` のbase引数はViteへ、`preview:web` のbase引数は配信prefixへ渡す実装にする。

### scriptの導入順と検証用設定

| 段階 | その段階で提供するもの |
|---|---|
| M0 | doctor、native scope型検査、build/dev:native-ui、tauri。純Web空画面はVite直接実行 |
| M1 | test:core、test:api、native Backendとself-test。Rust package試験も使用 |
| M2 | build:wasm、dev/build/preview:web、test:web、web/worker/test型検査。typecheck既定をallへ |
| M3 | 既存scriptで異常系を追加し、公開APIを拡張しない |

`vitest.config.ts` は製品のVite configをimportせず、Node環境で `tests/api/**/*.test.ts` を対象とする。`playwright.config.ts` は `tests/web/e2e` を対象とし、test用Worker harnessを通常E2Eや製品入口に混ぜない。実browserを用意する前にnpm installからbrowserを自動downloadするhookは作らない。

Web buildの成功時に、配信外の `dist/web-build.json` へbase、source/header/fixture/lockのhash、出力ファイル一覧/hashを記録する。preview/test:webはこの記録とdistを照合し、base不一致・欠落・古い出力を拒否する。ビルド中の出力を配信せず、一時出力の検査後に差し替える。配信中の再buildは同じ作業のserverを止めてから行う。

run phaseのdoctorは `--artifact` を必須とし、Webに `--url`、mobileに `--device` を加える。previewの `--host` は既定127.0.0.1、mobileから必要な場合だけ到達可能なアドレスを指定する。target/phaseに無関係な引数は黙って無視しない。

## NativeのC++ビルド

`crates/poc-core-ffi/build.rs` は `CARGO_MANIFEST_DIR` からsource/headerの絶対pathを組み立て、`cc` でC++17としてコンパイルし、Cargoの `OUT_DIR` へ出す。header/sourceの `rerun-if-changed` を出す。`.cpp(true)` 等の具体APIは固定したcc版で確認する。[cc公式](https://docs.rs/cc/latest/cc/)

重要なのは実際のtarget / sysroot / deployment targetと最終リンクである。Appleではホスト上のclangもクロスコンパイルに使うため、「HOSTとTARGETが異なるのにホストのclangだから不正」と判定しない。compiler引数と生成objectのCPU・OSを調べる。

| OS | 確認する点 |
|---|---|
| Windows | MSVC targetとC++ Build Tools / Windows SDK。MinGWと混在しない。CRTはCargo/ccの設定と揃える |
| macOS | arm64、macOS SDK、macOS deployment target |
| iOS | device / Simulatorを別target・別出力にする。arm64というCPU名だけでarchiveを共用しない |
| Android | NDKを単一版に固定。target別CXX/ARとNDK sysroot/APIを使用し、ホストcompilerを誤用しない |

AndroidはNDKのclang++にtriple/APIを渡すか、triple/API付きdriverを用いる。NDKのhost-tagはインストール先で検出し、Apple Siliconだから必ず `darwin-arm64` と推測しない。[NDK公式](https://developer.android.com/ndk/guides/other_build_systems)

初期案は最終nativeライブラリがTauri/Rustの1個の.soにまとまる範囲で `c++_static`。APKの.soと依存を調べて成立を確認し、複数のC++ .soが必要になった場合は共有runtime方針を再検討する。minSdk / NDK API / Emulator APIを整合させる。[Android C++ runtime](https://developer.android.com/ndk/guides/cpp-support)

## Emscriptenへ渡す引数

`scripts/build-wasm.mjs` が固定版em++へ渡す配列の内容。これはshell貼り付け用ではない。

```text
cpp/src/core.cpp
-I cpp/include
-std=c++17 -O2 -fno-exceptions -fno-rtti --no-entry
-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPocCore -sENVIRONMENT=worker
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 -sABORTING_MALLOC=0
-sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0
-sEXPORTED_FUNCTIONS=["_poc_core_abi_version","_poc_core_version","_poc_transform_i32","_malloc","_free"]
-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAP32","HEAPU32"]
-o web-public/wasm/poc-core.mjs
```

固定版でfactory、全exports、heap viewを実際に使えることを確認する。初期memory 16MiB、最大64MiBとし、`ABORTING_MALLOC=0` は確保失敗時の0返却を明示する。通常のMODULARIZEを使い、実験的instance方式、Embind、Asyncify、MEMORY64、pthread、SIMDは導入しない。[設定リファレンス](https://emscripten.org/docs/tools_reference/settings_reference.html)、[module出力](https://emscripten.org/docs/compiling/Modularized-Output.html)

emsdkのinstall/activateは具体的なversionで行う。有効化済み環境をbuild scriptへ渡す。Windowsの `.bat` はUnix executableと同じspawn方法では起動できないため、固定SDKのentry pointに合う方法を実装する。ユーザー入力をshell文字列へ連結しない。

## WebのURLと配信

UI側で `new URL(import.meta.env.BASE_URL, document.baseURI)` を基準に、`wasm/poc-core.mjs` と `wasm/poc-core.wasm` の同一origin URLを作ってWorker initへ渡す。baseは `/` または `/poc/` のような末尾slash付きpathに限定する。

Workerは `import(/* @vite-ignore */ moduleUrl)` のdefault factoryをawaitし、`locateFile` で同一buildのwasmUrlを返す。Emscripten glueを飛ばしてwasm単体を自己流ロードしない。Vite baseによるpath書換えとpublicファイルの参照方法を確認する。[Vite build](https://vite.dev/guide/build#public-base-path)

`preview:web` は検証用の小さな静的配信scriptとして実装する。製品のnativeサービスは作らない。Vite previewの既定挙動だけでMIME / 404 / CSPを満たしたとは扱わない。

- HTML/CSS/JS/mjs/wasmを正しいMIMEで返す。wasmは `application/wasm`。
- 指定prefix以外・欠落ファイルは404。欠落mjs/wasmにindex.htmlを200で返さない。
- `.html` だけでなくWorker scriptの応答にもCSPを付ける。基準は `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'` とし、実ブラウザで検証する。
- `Cache-Control: no-store` を基準にして、glue/wasmの別build混在を避ける。初回は配信キャッシュ機構を作らない。
- HTTP(S)で試す。file URLは正式対象外。COOP/COEPを要求せず `crossOriginIsolated=false` で成功を確認する。
- rootとsubpathはそれぞれbaseを指定してbuildし直し、別runとして記録する。`preview:web` のprefixだけを変えて済ませない。

## TauriとVite

`tauri.conf.json` のbuild節は次の関係とする。

```json
{
  "beforeDevCommand": "npm run dev:native-ui",
  "devUrl": "http://localhost:1420",
  "beforeBuildCommand": "npm run build:native-ui",
  "frontendDist": "../dist/native"
}
```

hookの作業directoryをrootへ合わせる。mobile devのVite host / HMRは `TAURI_DEV_HOST` を反映する。これらは開発時の設定で、同梱起動試験には使わない。[Tauri Vite連携](https://v2.tauri.app/start/frontend/vite/)

## target名の対応

| 対象 | Tauri CLIのtarget | Rust triple | 導入する形式 |
|---|---|---|---|
| macOS arm64 | aarch64-apple-darwin | aarch64-apple-darwin | .app |
| Windows x64 | x86_64-pc-windows-msvc | x86_64-pc-windows-msvc | .exe |
| iOS arm64 Sim | aarch64-sim | aarch64-apple-ios-sim | Simulator用.app |
| iOS arm64実機 | aarch64 | aarch64-apple-ios | 実機用.app等、署名条件別 |
| Android arm64 | aarch64 | aarch64-linux-android | arm64-v8aを含むAPK |
| Android x86_64 | x86_64 | x86_64-linux-android | x86_64を含むAPK |

CLI名はレビュー時の [Tauri CLI公式](https://v2.tauri.app/reference/cli/) と照合済み。採用版のhelpをM0で再確認する。

## 実装後に使う操作例

共通の初回処理は、root READMEに従うNodeの具体版への切り替え、`npm ci`、対象のdoctor。以下は各targetで別々に実行する。

```sh
# Web root
npm run doctor -- --target web
npm run build:web
npm run preview:web
# Web subpath: root配信を停止し、別runとして実行
npm run build:web -- --base /poc/
npm run preview:web -- --base /poc/ --port 4173
```

```sh
# macOS
npm run doctor -- --target native
npm run tauri -- build --debug --target aarch64-apple-darwin --bundles app
# Windowsホスト
npm run doctor -- --target native
npm run tauri -- build --debug --no-bundle --target x86_64-pc-windows-msvc
```

```sh
# mobile initは初回だけ。生成hostの既存変更を保護する
npm run tauri -- ios init
npm run tauri -- android init
# iOS Simulator
npm run doctor -- --target ios --device-class simulator --arch arm64
npm run tauri -- ios build --debug --target aarch64-sim
# Android arm64 Emulator。AVDがx86_64ならarchとtargetを対応させる
npm run doctor -- --target android --arch arm64
npm run tauri -- android build --debug --apk --target aarch64
```

全コマンドはbuild用で、Viteを停止してから以下の導入・起動を行う。Debug buildでも同梱UIを使って動けば初回対象とする。Release配布の検証とは区別する。

| 環境 | 導入と起動 | 記録 |
|---|---|---|
| macOS | buildログの実.appをFinderまたはopenで起動 | bundle ID、実.app、C++情報、画面 |
| Windows | 出力exeを直接起動 | 実.exe、WebView2版、C++情報、画面 |
| iOS Sim | 選定UDIDに `xcrun simctl install <UDID> <APP_PATH>`、`xcrun simctl launch <UDID> <BUNDLE_ID>` | UDID/runtime、Sim用成果物、画面。simctlの正確な構文はXcode helpで照合 |
| Android Emu | `adb -s <SERIAL> install -r <APK_PATH>`、対象AVDのホームから起動 | serial、ABI/API、APK、画面。端末を暗黙選択しない |

出力pathはbuildログ・成果物一覧から取得し、別runの古いアプリを起動しない。macOSからWindowsのGUI起動成功を推測しない。mobile WebはEmulator/Simulatorから到達する配信URLを別途確認し、localhostを開発機と同じ意味だと思い込まない。
