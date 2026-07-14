$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$pidFile = Join-Path $rootDir 'logs\reviewer.pid'

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host 'Classroom Office Reviewer は起動していません。'
    exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
if ($null -eq $process -or $process.CommandLine -notlike '*classroom-word-reviewer*native*server.mjs*') {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host '補助アプリのプロセスはすでに終了しています。'
    exit 0
}

try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8765/shutdown' -Method Post -TimeoutSec 3 | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 150
        if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { break }
    }
} catch {}

if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $serverPid -Force
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Classroom Office Reviewer を終了しました。' -ForegroundColor Green
