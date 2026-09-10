# 実行記録: <run-id>

この雛形をrunごとにコピーする。shared版には個人path・serial・秘密を載せず、local版だけに実値を保存する。

| 項目 | 値 |
|---|---|
| 日時・timezone | 未記録 |
| 計画版・実装ステップ | v1.2、ステップ未記録 |
| 対象ID / 試験ID | 未記録 |
| 具体ケース・root/subpath等の条件 | 未記録 |
| 担当・ホスト識別子 | 未記録 |
| repository / branch / HEAD | 未記録。未初期化ならその旨 |
| dirty状態・source一覧/hash | 未記録 |
| build profile / target triple / ABI | 未記録 |
| OS / CPU / SDK / deployment target | 未記録 |
| Simulator / Emulator / 実機の区別 | 未記録 |
| browser / WebViewの実版 | 未記録 |
| toolchains.lock.jsonのhash | 未記録 |
| app / distのhash・配置先 | 未記録 |
| 結果 | NOT_RUN |

## 操作と結果

| 手順 | 実コマンドまたはUI操作 | 終了code・期待 | 実結果 | ログ・画面 |
|---|---|---|---|---|
| 1 | 未記録 | 未記録 | NOT_RUN | |

- Native: Vite停止確認、同梱成果物の導入・起動、bundle ID、self-test件数/失敗ID。
- Web: root/subpath、実URL、CSP/MIME/404の応答、Worker/WASM記録、crossOriginIsolated。
- 比較: 使用fixtureのhash、全要素・checksum・入力不変の結果。
- 障害: 最初の失敗、原因の確認済み範囲、再現コマンド、復旧後runへの参照。
- 次の操作: 未記録。

プロセスの起動成功と画面内の計算成功を区別する。想定したエラーの拒否試験が成功した場合は、試験PASSと受け取ったAppError codeを記録する。
