$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# サーバーを起動
& (Join-Path $nativeDir 'Start-Reviewer.ps1') -Quiet

# Native MessagingのJSONメッセージヘッダを読んで維持する
$stdin = [System.Console]::OpenStandardInput()
$buffer = New-Object byte[] 4
$stdout = [System.Console]::OpenStandardOutput()
$message = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true}')
$header = [System.BitConverter]::GetBytes([int]$message.Length)
$stdout.Write($header, 0, $header.Length)
$stdout.Write($message, 0, $message.Length)
$stdout.Flush()

function Read-Exactly([byte[]]$target, [int]$length) {
    $offset = 0
    while ($offset -lt $length) {
        $read = $stdin.Read($target, $offset, $length - $offset)
        if ($read -eq 0) { return $false }
        $offset += $read
    }
    return $true
}
try {
    while (Read-Exactly $buffer 4) {
        $length = [System.BitConverter]::ToInt32($buffer, 0)
        if ($length -lt 0 -or $length -gt 1048576) { break }
        $payload = New-Object byte[] $length
        if (-not (Read-Exactly $payload $length)) { break }
        try { $request = [System.Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json }
        catch { continue }
        if ($request.type -eq 'ensure-started') {
            & (Join-Path $nativeDir 'Start-Reviewer.ps1') -Quiet
        }
    }
} finally {
    # 拡張機能がアンロードされたかChromeが閉じたのでサーバーを終了
    & (Join-Path $nativeDir 'Stop-Reviewer.ps1') | Out-Null
}

