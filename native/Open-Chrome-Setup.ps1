$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$extensionDir = Join-Path $rootDir 'extension'

Set-Clipboard -Value $extensionDir

$chrome = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)'
if (-not $chrome) {
    $chrome = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)'
}
if (-not $chrome) {
    throw 'Google Chrome が見つかりませんでした。'
}

Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/'
Write-Host 'Chrome の拡張機能画面を開きました。読み込むフォルダの場所はクリップボードにコピー済みです。' -ForegroundColor Green
Write-Host $extensionDir
