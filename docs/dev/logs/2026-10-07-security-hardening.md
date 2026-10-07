# 2026-10-07 補助アプリの接続制限
- すべてのHTTP経路でHostを127.0.0.1/localhostの実ポートに限定し、重複Host/Originを拒否する。
- ブラウザのOriginはmanifest公開鍵から求めた既存拡張IDだけを許可する。ID・権限・キャッシュ・提出物・Office変換は変更しない。
- Originなしの変更要求はX-Reviewer-Native: 1を必須とする。停止スクリプトをこの方式に合わせ、ブラウザ用CORSにはこのヘッダーを許可しない。
- tests/test-http-security.mjsで隔離した実HTTPサーバーに対する外部拡張・別サイト・Host差し替え・Originなし変更要求の拒否、正規Origin/ネイティブ要求/OPTIONS/停止を確認した。
- node --check native/server.mjs、node --test tests/test-http-security.mjs、node tests/validate-release.mjs、git diff --check成功。
- 実Chromiumの拡張サービスワーカーからGET/POSTの正常通信を確認した。Defaultプロファイルに登録された既存IDとmanifestのIDの一致も確認した。
- Google Classroom授業画面、実提出物、Office本体は操作していない。補助アプリの更新は利用終了後の再起動で反映する。
