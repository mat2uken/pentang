# 08. 着手と別ホストへの引き継ぎ

## 最初に実施する作業

実装に着手する依頼を受けた後、[M0-01の具体手順](implementation/01-setup-native.md#m0-01) から始める。[03の依存表](03-implementation-plan.md) と [工程tracker](templates/implementation-tracker.md) を使い、計画改訂の依頼だけをGit初期化・実装・commit・pushの実施依頼として扱わない。

1. root、Gitの有無、branch/HEAD、既存変更を再確認する。docsと `AGENTS.md` を保持する。
2. Node 24の実版を選び、共通toolchainを固定する。[参照4定義](reference/poc-v1/README.md) を規定位置へ置き、hashとimport変更を記録する。
3. root README、matrix、toolchain lock、doctorと最小templateを作る。scriptは [05](05-build-run.md) の名前・引数で実装する。
4. macOS/Webの空画面とmobileの前提を確認し、Windows利用先を記録する。
5. M1で共通C++の試験、macOS実FFI、mobile最終リンクを確認する。結果を見てM2へ進める。

## Git管理するもの・しないもの

| 方針 | 対象 |
|---|---|
| 管理する | source、型/header、fixture、各lock、再生成script、Tauri設定、共有するmatrix/要約 |
| 生成後に必要部分を管理する | Tauri mobile host、Gradle wrapper、Xcode/Gradle設定。生成版・再生成コマンドを記録 |
| 管理しない | node_modules、Cargo target、CMake build、dist、mjs/wasm生成物、SDK本体 |
| ローカルに保持する | local.properties、署名秘密、個人path/serialを含む生ログ、実行時の端末一覧 |

`src-tauri/gen/` を一括ignoreして、別ホストで必要なmobile設定まで失わない。`gen/android` と `gen/apple` の必要ファイル、生成schema、各build出力を区別する。過去版として置いたdocs/referenceを製品の第2の実装先にしない。

`.gitattributes` でsource・型/header・JSON・設定・Markdownの改行をLFに揃え、Windowsへの受け渡しでも参照ファイルのhashを比較できるようにする。端末固有のpathは環境設定へ置き、lockや共通sourceへ書き込まない。

## 別ホストへ渡す情報

| 必須情報 | 内容 |
|---|---|
| 対象 | N-WIN等の対象ID、host、CPU/ABI、実行する段階 |
| source | repository、指定branch/HEAD、dirty状態。Git未使用ならsource一式とhash |
| 工程 | M4-05等の実行ステップ、先行結果、対象に適用する試験IDとケース |
| 手順 | root README、docs/05、target別doctor、固定版、既知の障害 |
| 比較 | fixture hash、他OSで使った同一sourceのrun ID |
| 保存先 | reportsのmatrixとrun記録、ローカルログの扱い |

## 引き継ぎプロンプト

```text
このPoCの指定targetを、このホストでビルド・起動検証してください。
対象ID: <対象ID>
対象repository / branch / HEAD: <実値>
対象作業と許可範囲: <実行・修正範囲>

まずroot README、docs/README.md、docs/05-build-run.md、
reports/verification-matrix.mdを読み、対象sourceと既存変更を確認してください。
docs/03-implementation-plan.mdから指定ステップの詳細手順を開き、
docs/12-test-case-catalog.mdの該当ケースも確認してください。
対象のdoctorから始め、同じC++を使って最終アプリをビルドしてください。
Vite停止後にその成果物を起動し、版情報と共通self-testを確認してください。
問題の修正はtarget設定・FFI・生成手順へ絞り、別OSの実装へ分岐させないでください。
実コマンド、結果、成果物hash、画面・ログ参照をrun記録へ保存してください。
他OSの未実行行をPASSへ変更しないでください。commitとpushは個別の指示に従ってください。
```

別担当や別セッションに渡す場合は予想所要時間と十分な待ち時間も伝える。共通作業方針どおり、目安の約2倍のtimeoutを取り、頻繁な進捗照会を行わない。失敗時も最後の結果・障害・次の最小操作を受け取る。

## 各段階のレビュー項目

- [ ] 共通UI/API/C++を保ち、Rust/JSの代替計算や失敗時の切り替えがない。
- [ ] target別compiler、SDK、mobile entry、command権限が実設定と一致する。
- [ ] 数値、エラー、8要求、timeout、disposeの挙動が04に一致する。
- [ ] nativeはemsdk不要、WebはRust不要で、生成物も分離されている。
- [ ] build・起動・self-test・同梱起動を区別し、対象とsourceと結果が紐付く。
- [ ] 初回必須と後続の行を保持し、未実行を成功と書いていない。
