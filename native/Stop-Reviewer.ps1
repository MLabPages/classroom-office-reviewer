$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$dataBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $rootDir }
$dataRoot = Join-Path $dataBase 'ClassroomReviewer'
$pidFile = Join-Path $dataRoot 'logs\reviewer.pid'
$healthUri = 'http://127.0.0.1:18765/health'
$shutdownUri = 'http://127.0.0.1:18765/shutdown'

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host 'Classroom Office Reviewer は起動していません。'
    exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 1
} catch {
    $health = $null
}
if ($null -eq $health -or -not $health.ok -or $health.service -ne 'Classroom Office Reviewer') {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host '補助アプリのプロセスはすでに終了しています。'
    exit 0
}

try {
    Invoke-RestMethod -Uri $shutdownUri -Method Post -TimeoutSec 3 | Out-Null
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
