param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$powerPoint = $null
$presentation = $null

function Release-Object($Value) {
    if ($null -ne $Value) {
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) } catch {}
    }
}

try {
    $target = [System.IO.Path]::GetFullPath($OutputPath)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null

    $powerPoint = New-Object -ComObject PowerPoint.Application
    $powerPoint.Visible = -1
    $presentation = $powerPoint.Presentations.Add()

    $slide1 = $presentation.Slides.Add(1, 1)
    $slide1.Shapes.Title.TextFrame.TextRange.Text = '日本語発表テスト'
    $slide1.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = "Classroom Office Reviewer`r全画面表示とレイアウト確認"
    $banner = $slide1.Shapes.AddShape(1, 80, 390, 800, 80)
    $banner.Fill.ForeColor.RGB = 15177436
    $banner.Line.Visible = 0
    $banner.TextFrame.TextRange.Text = '矢印キー・PageDown・Spaceで次のページへ'
    $banner.TextFrame.TextRange.Font.Size = 22
    Release-Object $banner
    Release-Object $slide1

    $slide2 = $presentation.Slides.Add(2, 2)
    $slide2.Shapes.Title.TextFrame.TextRange.Text = '研究発表の確認項目'
    $slide2.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = "・文字化けがない`r・図形と余白がずれない`r・全画面でページ送りできる`r・終了後に一時ファイルを残さない"
    $accent = $slide2.Shapes.AddShape(9, 690, 310, 130, 130)
    $accent.Fill.ForeColor.RGB = 13395456
    $accent.Line.Visible = 0
    Release-Object $accent
    Release-Object $slide2

    $presentation.SaveAs($target, 24)
    Write-Output $target
}
finally {
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch {}
        Release-Object $presentation
    }
    if ($null -ne $powerPoint) {
        try { $powerPoint.Quit() } catch {}
        Release-Object $powerPoint
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
