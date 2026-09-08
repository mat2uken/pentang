# 01. 環境確認・版の固定

## v1.1のレビューで確認した事実

確認日: 2026-09-08。以下は前回v1.1のレビュー中に取得した読み取り専用コマンドの出力であり、PoCをビルドした結果ではない。v1.2では環境のinstallや切り替えを行わず、実装M0で再測定する。

| 項目 | 今回の実測 |
|---|---|
| 作業先 | Git未初期化、レビュー開始時はdocsのみ |
| OS / CPU | macOS 26.6.2 (25G83) / arm64 |
| Xcode | 26.6 (17F113)、`xcode-select -p` で選択済み |
| SDK | macOS / iPhoneOS / iPhoneSimulatorはいずれも26.5 |
| Rust / Cargo | 1.96.1 / 1.96.1 |
| Node / npm | 26.4.0 / 11.17.0。採用予定のNode 24とは異なる |
| CMake | 4.3.4 |
| JDK | OpenJDK 21.0.11 |
| em++ / emulator / sdkmanager | 今回のshellのPATH上では見つからない。ディスク全体での不存在は未確認 |
| CocoaPods | `pod` のshimはPATH上にある。実行可能性・版は未確認 |

旧計画にあるRust target一覧、NDK 26.1/28.1/28.2、Android platform一覧、Simulator機種、Chrome/Safari版は今回再取得していない。M0で実測し直す。Windows機の利用可否、Firefox、AVD、モバイルブラウザ、Apple署名状態も未確認である。

## 採用済みの方向と未固定の値

旧計画からNode 24 LTS、iOS Simulator先行、Android Emulatorのみを継承する。Tauri 2、Vanilla TypeScript、C++17、通常のEmscripten ES module factoryを採る。具体的なpatch版は未解決であり、このレビューではSDKや依存を導入しない。

M0でNode/npm、Vite/TypeScript、Tauri CLI/API/crates、Rust/cc、CMakeを実測固定する。EmscriptenはM2着手前、各SDKは該当targetのビルド開始前に固定する。LTSの確認には [Node公式](https://nodejs.org/en/about/previous-releases)、プラットフォーム前提には [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) を使う。特定Vite majorを必要条件だけで先に決めず、選んだ版のengine・build結果で組み合わせを決める。

| 保存先 | 内容 |
|---|---|
| `package.json` / `package-lock.json` | npm依存の採用版と解決結果。ツール用依存も固定 |
| `.node-version` / `package.json` | Node 24の実patch版、必要なnpm版・engine条件 |
| `rust-toolchain.toml` / `Cargo.lock` | Rustの具体版とcrate解決結果。`stable`のままにしない |
| `toolchains.lock.json` | 共通版と対象別SDKの期待値・確認状態 |
| `reports/runs/<run-id>/` | 実際に使った版、compiler引数、target、日時、OS / browser / WebView版 |

対象外のSDKが未固定でも他のM0作業は進める。該当targetの開始前にその部分を解決し、全必須行の完了時には必要な値を全て埋める。全体を架空値や`latest`で埋めない。lock JSONは記録であり、実際の固定は各設定ファイルとdoctorの照合で行う。

## doctorの入出力

実装予定: `npm run doctor -- --target <web|native|android|ios> --phase <tools|build|run>`。phase省略時はbuild。iOSは `--device-class simulator|device`、mobileは `--arch arm64|x86_64` で実際のtargetを指定する。実装箇所はM0-03。

| phase | 必須にする項目 | 必須にしない項目 |
|---|---|---|
| tools | 選択targetの外部tool・版・SDK | 未生成のproject/lock、未導入の実行端末/browser |
| build | toolsに加え、依存導入、生成project、選択targetのlock/設定 | 起動用のbrowser、AVDのboot、実機接続 |
| run | build済み成果物と起動に必要な環境 | C++/Rust/emsdk等の再ビルド用tool |

| target | tools/buildでの診断 | 診断しないもの |
|---|---|---|
| web | Node/npm、固定em++、build script/lock。browserとHTTP条件はrunで診断 | Rust、Xcode、NDK |
| native | Node/npm、Rust、選択targetのC++ compiler、SDK。WindowsのWebView2はrunで確認 | emsdk、mobile SDK |
| android | Node/npm、Rust target、JDK、SDK、単一NDK、ABI/API設定。生成後にGradle wrapperを確認 | Xcode、emsdk |
| ios simulator | Node/npm、Rust sim target、完全なXcode、SDK、必要なCocoaPods。runtime/UDIDはrunで確認 | 実機用team・provisioningを成功条件にしない |
| ios device | iOS SDK、Rust device target、対象端末、実際の署名準備 | Simulatorの成功を流用しない |

各項目をFOUND / MISSING / MISMATCH / NOT_CHECKEDで出し、期待値・実測値・対処を表示する。必須項目不足は非0終了。診断中に自動install、SDK変更、実機起動、署名変更を行わない。UI試験に使うbrowser不足とビルドtool不足は別項目にする。

run phaseは `--artifact <path>` を必須とし、Webには `--url <HTTP(S) URL>`、mobileには `--device <UDIDまたはserial>` を指定する。Webの公開先へアクセスする一般利用者にdoctorやNodeを要求する意味ではない。M0の純粋なWeb空画面はViteだけで調べ、emsdkが必要な最終Web doctor/buildはM2から使う。

## M0で特に早く解決すること

1. Node管理手段は既存のものを優先し、この作業用shellにNode 24を選ぶ。ホスト全体の既定版を変更しない。切替後のnpmも再記録する。
2. iOS Simulatorのruntime / 機種 / UDID、Android AVDのimage / API / ABIを1つずつ選ぶ。Intel向けx86_64例をApple Siliconへ無条件に流用しない。
3. NDKの実pathを単一版へ解決し、JDK・Gradle・minSdk・compileSdk・NDK APIを記録する。
4. Tauri標準mobile hostを早期生成し、空アプリでのビルド障害をM0で発見する。team要求が出たら、そのCLI版のSimulator手順を確認する。
5. Windows検証ホストと担当を確保する。未定なら継続可能な作業を進めつつ、N-WINを未検証として残す。

SDK診断に端末一覧が必要な場合も、このレビューでは端末を変更しない。実装・起動検証時に対象を指定する。
