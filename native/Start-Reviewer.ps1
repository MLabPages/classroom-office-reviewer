param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$dataBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $rootDir }
$dataRoot = Join-Path $dataBase 'ClassroomReviewer'
$logsDir = Join-Path $dataRoot 'logs'
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

$startupMutex = New-Object System.Threading.Mutex($false, 'Local\ClassroomOfficeReviewer.Start')
$lockTaken = $false
try {
    try { $lockTaken = $startupMutex.WaitOne(45000) }
    catch [System.Threading.AbandonedMutexException] { $lockTaken = $true }
    if (-not $lockTaken) { throw '補助アプリの起動を別の操作が実行中です。少し待ってお試しください。' }

    $health = $null
    try { $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 20 } catch {}
    if ($health.ok -and $health.service -eq 'Classroom Office Reviewer') {
        if ($health.version -eq $expectedVersion) {
            if (-not $Quiet) { Write-Host 'Classroom Office Reviewer はすでに起動しています。' -ForegroundColor Green }
            return
        }
        if (-not $Quiet) { Write-Host "補助アプリを v$expectedVersion に更新しています。" -ForegroundColor Yellow }
        Invoke-RestMethod -Method Post -Uri $shutdownUri -Headers @{ 'X-Reviewer-Native' = '1' } -TimeoutSec 3 | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            try { Invoke-RestMethod -Uri $healthUri -TimeoutSec 1 | Out-Null }
            catch { break }
        }
    } elseif ($health) {
        throw '補助アプリ用のポートを別のアプリが使用しています。'
    }

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

    $startupClock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($startupClock.Elapsed.TotalSeconds -lt 45) {
        Start-Sleep -Milliseconds 200
        try {
            $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
            if ($health.ok -and $health.service -eq 'Classroom Office Reviewer' -and $health.version -eq $expectedVersion) {
                if (-not $Quiet) { Write-Host 'Classroom Office Reviewer を起動しました。Chrome の Classroom で使用できます。' -ForegroundColor Green }
                return
            }
        } catch {}
        $process.Refresh()
        if ($process.HasExited) { break }
    }
    throw "補助アプリを起動できませんでした。ログを確認してください: $stderrPath"
} finally {
    if ($lockTaken) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
