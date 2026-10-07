# 2026-10-07 旧版補助アプリの接続制限
- 全chrome-extensionオリジンの許可をやめ、この配布フォルダの拡張IDだけを許可する。keyがない既存manifestはChromiumのWindowsパスID生成方式を使い、manifestと既存データは変更しない。
- 全HTTP経路でローカルHostと単一Originを検査する。Originなしの変更要求にはX-Reviewer-Native: 1を要求し、停止スクリプトに付ける。
- tests/test-http-security.mjsは隔離サーバーとダミーPDFだけを使い、他の拡張からの読み取り/変換、Host差し替え、Originなし変更を拒否する。正規拡張、ネイティブ制御、停止を確認する。
- node --check native/server.mjs、node --test tests/test-http-security.mjs、git diff --check成功。
- 実Chromiumでkeyなし拡張を読み込み、パスから生成したIDでGET/POSTの正常通信が許可されることを確認した。
- 現行classroom-office-reviewerと同じGitHub repoに接続しているが、旧版のmainは現行origin/mainより大きく遅れているため、旧版の修正は別ブランチで保管する。現行mainへ旧版を取り込まない。
- 実Google Classroom/Officeは操作していない。旧版は現行版への更新を推奨する。
