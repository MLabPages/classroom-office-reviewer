$ErrorActionPreference = 'Stop'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $nativeDir 'native-host.json'
$cmdPath = Join-Path $nativeDir 'native-host.cmd'

if (-not (Test-Path $manifestPath)) {
    Write-Error "マニフェストファイルが見つかりません: $manifestPath"
}

# manifest.json の path を絶対パスに更新する
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest.path = $cmdPath
$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding UTF8

# HKCUのNativeMessagingHostsに登録する
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mlabpages.classroom_reviewer"
if (-not (Test-Path $registryPath)) {
    New-Item -Path $registryPath -Force | Out-Null
}
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath -Type String

Write-Host "Chrome拡張機能の自動起動(Native Messaging Host)を登録しました。" -ForegroundColor Green
Write-Host "Chromeの拡張機能(Classroom Office Reviewer)が有効になると、補助アプリも連動して起動・終了するようになります。"
Start-Sleep -Seconds 3


