$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# サーバーを起動
& (Join-Path $nativeDir 'Start-Reviewer.ps1') | Out-Null

# Native MessagingのJSONメッセージヘッダを読んで維持する
$stdin = [System.Console]::OpenStandardInput()
$buffer = New-Object byte[] 4
try {
    while ($true) {
        $bytes = $stdin.Read($buffer, 0, 4)
        if ($bytes -eq 0) {
            break
        }
    }
} finally {
    # 拡張機能がアンロードされたかChromeが閉じたのでサーバーを終了
    & (Join-Path $nativeDir 'Stop-Reviewer.ps1') | Out-Null
}

