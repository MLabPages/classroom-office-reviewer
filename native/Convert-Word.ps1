param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
$word = $null
$document = $null
$workingCopy = $null

try {
    $source = [System.IO.Path]::GetFullPath($SourcePath)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw '提出物ファイルが見つかりません。'
    }

    $extension = [System.IO.Path]::GetExtension($source).ToLowerInvariant()
    if ($extension -notin @('.doc', '.docx')) {
        throw 'Wordファイル（.doc / .docx）ではありません。'
    }

    $targetDirectory = [System.IO.Path]::GetDirectoryName($target)
    [System.IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
    $workingCopy = Join-Path $targetDirectory (([System.Guid]::NewGuid().ToString('N')) + $extension)
    Copy-Item -LiteralPath $source -Destination $workingCopy -Force
    Unblock-File -LiteralPath $workingCopy -ErrorAction SilentlyContinue

    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $document = $word.Documents.Open($workingCopy, $false, $true, $false)
    $pageCount = $document.ComputeStatistics(2)
    $document.ExportAsFixedFormat($target, 17)
    $document.Close(0)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    $document = $null

    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw 'PDFファイルを作成できませんでした。'
    }

    @{ ok = $true; pageCount = $pageCount } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $document) {
        try { $document.Close(0) } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } catch {}
    }
    if ($null -ne $word) {
        try { $word.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {}
    }
    if ($workingCopy -and (Test-Path -LiteralPath $workingCopy)) {
        Remove-Item -LiteralPath $workingCopy -Force -ErrorAction SilentlyContinue
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
