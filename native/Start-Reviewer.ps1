$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$logsDir = Join-Path $rootDir 'logs'
$serverPath = Join-Path $nativeDir 'server.mjs'
$stdoutPath = Join-Path $logsDir 'reviewer.log'
$stderrPath = Join-Path $logsDir 'reviewer-error.log'
$healthUri = 'http://127.0.0.1:18765/health'
$shutdownUri = 'http://127.0.0.1:18765/shutdown'
$manifestPath = Join-Path $rootDir 'extension\manifest.json'
# Windows PowerShell 5.1 treats UTF-8 files without a BOM as the system code
# page. Read the extension manifest explicitly as UTF-8 before parsing JSON.
$manifestJson = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw
$expectedVersion = ($manifestJson | ConvertFrom-Json).version

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 1
    if ($health.ok -and $health.version -eq $expectedVersion) {
        Write-Host 'Classroom Office Reviewer はすでに起動しています。' -ForegroundColor Green
        exit 0
    }
    if ($health.ok) {
        Write-Host "古い補助アプリ v$($health.version) を終了し、v$expectedVersion に入れ替えます。" -ForegroundColor Yellow
        Invoke-RestMethod -Method Post -Uri $shutdownUri -TimeoutSec 3 | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            try {
                Invoke-RestMethod -Uri $healthUri -TimeoutSec 1 | Out-Null
            } catch {
                break
            }
        }
    }
} catch {}

$bundledNode = Join-Path $rootDir 'runtime\node.exe'
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $node = $bundledNode
} else {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
}
$process = Start-Process -FilePath $node `
    -ArgumentList @("`"$serverPath`"") `
    -WorkingDirectory $rootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
        $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 1
        if ($health.ok -and $health.version -eq $expectedVersion) {
            Write-Host 'Classroom Office Reviewer を起動しました。Chrome の Classroom で使用できます。' -ForegroundColor Green
            exit 0
        }
    } catch {}
    if ($process.HasExited) { break }
}

Write-Error "補助アプリを起動できませんでした。ログを確認してください: $stderrPath"
