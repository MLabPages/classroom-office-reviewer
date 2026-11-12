# 2026-11-12 自動起動と現行Classroomへの対応

## 問題と変更

- 現行の `/submissions/.../student/<id>/m/<attachment>` を学生IDとして認識できず、同じ学生のPDFを別学生の結果として破棄していた。旧 `#u=` 形式も維持してパス形式に対応した。
- 提出状態を伴わない「生徒を選択する」comboboxから現在の名前を読む。課題内の一覧保存キーから学生・添付のパスを除き、学生を切り替えても同じ課題の一覧を使う。
- 現行の添付listboxを対象に含める。Classroom内の添付番号とDrive IDを区別し、複数添付のZIPでは実際に選択してプレビューIDを確認する。
- `Setup-Reviewer.cmd` で初回だけ自動起動を登録する。配布ZIPにも登録コマンドを含める。拡張は起動完了まで接続を待ち直し、並行要求では起動確認を共有する。
- 起動スクリプトに排他制御を追加。旧版の終了要求に既存のローカル制御用ヘッダーを付け、二重起動で稼働中プロセスのPIDファイルを消さない。
- `/health` で全PDFを検査しない。キャッシュ使用量の確認は `/cache-summary` のみにする。
- Native Messagingの標準出力をバイナリJSONに限定し、分割されたメッセージも正しく読み取る。
- 名前を持たないDriveフレームよりClassroom側のPDF名を優先する。ビューアーが読み込めない場合にも操作パネルを残し、空のsrcdocが付いた表示用iframeは一度だけ再読込する。

## 検証

- `node tests/validate-release.mjs`：合格。現行URL、学生名、同名の複数添付、旧UI互換、起動時の再試行・版の切替待ち・並行要求を含む。
- `node --test tests/native-host.mjs`：Windows PowerShellでフレーム化した応答と分割受信を確認。
- `node --test tests/test-http-security.mjs`：合格。既存の接続元制限を維持。
- `node tests/bulk-preparation-flow.mjs`、`node tests/preparation-visibility-ui.mjs`：合格。
- このPCで初回登録を実行し、手動起動なしでv0.9.10へ接続・PDF取得することを確認。
- 実画面でPDFの最終描画とZIP完成を引き続き確認する。学生名・学生番号・提出物本文・個別のClassroom URLは作業記録に残さない。

## 作業範囲

既存の未追跡AGENTS.mdとdocsは別の変更として保持する。提出物・保存済みPDF・Chromeの既存設定は削除せず、拡張権限や外部依存は追加しない。

## 追記：v0.9.11 ZIP用ページの起動

- 利用者がPDF表示の復旧を確認。ZIPは全員の巡回後、元の学生へ戻ってから作業ページの起動待ちで失敗した。位置の復元自体は正常な処理。
- PDF用に追加した空srcdocからの復旧をZIP用iframeにも共通適用する。
- ZIP用ページの準備完了を巡回前に確認する。読み込み後のpingにも応答し、起動通知の取り逃しを防ぐ。失敗時には監視を解除する。
- chrome-extension URLの宛先はprotocolとhostから作り、opaque originの文字列 `null` や無制限の宛先へ送信しない。
- 起動確認の送信元・オリジン検証、再確認、タイムアウト後の監視解除、モジュール初期化と応答のテストを追加。`node tests/validate-release.mjs` は合格。
- 実環境のZIP完成確認は、ブラウザ操作接続のタイムアウトにより利用者に依頼中。
