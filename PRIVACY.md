# プライバシー説明

Classroom Office Reviewerは、Google Classroom上のWord／PowerPoint提出物を、利用者自身のWindows PCにインストールされたMicrosoft Officeで表示するツールです。

## 外部へ送信しないもの

- 提出物ファイルの内容
- 学生名、学籍番号などの画面情報
- Officeで作成した表示用PDF

これらを開発者、AIサービス、外部の文書変換サービスへ送信する処理はありません。

## 通信先

- `classroom.google.com`、`drive.google.com`、`docs.google.com`: 利用者がログインしているGoogle Classroom／Driveから提出物を取得するため
- `127.0.0.1:18765`: Chrome拡張と、このPC内で動く補助アプリが通信するため。インターネット上のサーバーではありません

## PC内に一時保存するもの

- 表示用PDF: 最大600件、最終利用から24時間まで（件数やページ数によっては数GBになる場合があります）
- 動作ログ: 起動・停止やエラー確認用。提出物本文は記録しません
- Google側の制限で一時ダウンロードした元ファイル: 変換直後に削除

`Stop-Reviewer.cmd` で補助アプリを終了すると、表示用PDFを削除します。アンインストールする場合は、Chromeから拡張機能を削除したうえで、展開したフォルダを削除してください。

## 権限を使う理由

- `downloads`: Google側がメモリ内取得を許可しない場合の一時取得と、その直後の削除
- `storage`: 機能ON／OFF、自動表示、表示モードの設定保存
- `tabs`／`webNavigation`: Classroom内で表示されている提出物フレームの特定
- Classroom／Drive／Docsへのアクセス: 開いている提出物の識別と取得

## 注意

本ツールはGoogleおよびMicrosoftの公式製品ではありません。Google Classroomの画面構造変更により、更新が必要になる場合があります。
