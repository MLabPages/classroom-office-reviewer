param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
$powerPoint = $null
$presentation = $null
$workingCopy = $null

try {
    $source = [System.IO.Path]::GetFullPath($SourcePath)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw '提出物ファイルが見つかりません。'
    }

    $extension = [System.IO.Path]::GetExtension($source).ToLowerInvariant()
    if ($extension -notin @('.ppt', '.pptx')) {
        throw 'PowerPointファイル（.ppt / .pptx）ではありません。'
    }

    $targetDirectory = [System.IO.Path]::GetDirectoryName($target)
    [System.IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
    $workingCopy = Join-Path $targetDirectory (([System.Guid]::NewGuid().ToString('N')) + $extension)
    Copy-Item -LiteralPath $source -Destination $workingCopy -Force
    Unblock-File -LiteralPath $workingCopy -ErrorAction SilentlyContinue

    # PowerPointはPDF形式で保存すると、拡張子がない保存先へ自動的に
    # .pdfを追加する。補助アプリは未完成扱いの .pdf.part を受け取るため、
    # PowerPointには実際の .pdf を渡し、完了後に期待する名前へ移す。
    $powerPointTarget = $target
    if ($target.EndsWith('.pdf.part', [System.StringComparison]::OrdinalIgnoreCase)) {
        $powerPointTarget = $target.Substring(0, $target.Length - '.part'.Length)
    }

    $powerPoint = New-Object -ComObject PowerPoint.Application
    $powerPoint.AutomationSecurity = 3
    $presentation = $powerPoint.Presentations.Open($workingCopy, $true, $false, $false)
    $pageCount = $presentation.Slides.Count
    $presentation.SaveAs($powerPointTarget, 32)
    $presentation.Close()
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation)
    $presentation = $null

    if ($powerPointTarget -ne $target) {
        if (-not (Test-Path -LiteralPath $powerPointTarget -PathType Leaf)) {
            throw 'PDFファイルを作成できませんでした。'
        }
        Move-Item -LiteralPath $powerPointTarget -Destination $target -Force
    }

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
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch {}
    }
    if ($null -ne $powerPoint) {
        try { $powerPoint.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) } catch {}
    }
    if ($workingCopy -and (Test-Path -LiteralPath $workingCopy)) {
        Remove-Item -LiteralPath $workingCopy -Force -ErrorAction SilentlyContinue
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
