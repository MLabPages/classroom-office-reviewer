$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$logsDir = Join-Path $rootDir 'logs'
$serverPath = Join-Path $nativeDir 'server.mjs'
$stdoutPath = Join-Path $logsDir 'reviewer.log'
$stderrPath = Join-Path $logsDir 'reviewer-error.log'

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 1
    if ($health.ok) {
        Write-Host 'Classroom Office Reviewer はすでに起動しています。' -ForegroundColor Green
        exit 0
    }
} catch {}

$bundledNode = Join-Path $rootDir 'runtime\node.exe'
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $node = $bundledNode
} else {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
}
$process = Start-Process -FilePath $node `
    -ArgumentList @($serverPath) `
    -WorkingDirectory $rootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 1
        if ($health.ok) {
            Write-Host 'Classroom Office Reviewer を起動しました。Chrome の Classroom で使用できます。' -ForegroundColor Green
            exit 0
        }
    } catch {}
    if ($process.HasExited) { break }
}

Write-Error "補助アプリを起動できませんでした。ログを確認してください: $stderrPath"
