param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$word = $null
$document = $null

try {
    $target = [System.IO.Path]::GetFullPath($OutputPath)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Add()
    $selection = $word.Selection

    $selection.Font.Name = 'Yu Mincho'
    $selection.Font.NameFarEast = '游明朝'
    $selection.Font.Size = 16
    $selection.Font.Bold = 1
    $selection.ParagraphFormat.Alignment = 1
    $selection.TypeText('研究計画書 - 日本語表示テスト')
    $selection.TypeParagraph()
    $selection.TypeParagraph()

    $selection.Font.Size = 10.5
    $selection.Font.Bold = 0
    $selection.ParagraphFormat.Alignment = 0
    $selection.TypeText('目的：Chrome上でも、文字化けや改行崩れを起こさずに提出物を確認する。')
    $selection.TypeParagraph()
    $selection.TypeText('検証文字：髙・﨑・①・「括弧」・英数字 ABC 123')
    $selection.TypeParagraph()
    $selection.TypeParagraph()

    $table = $document.Tables.Add($selection.Range, 4, 2)
    $table.Borders.Enable = 1
    $table.Cell(1, 1).Range.Text = '項目'
    $table.Cell(1, 2).Range.Text = '内容'
    $table.Cell(2, 1).Range.Text = '研究背景'
    $table.Cell(2, 2).Range.Text = 'SNSと商品デザインの関係を検討する。'
    $table.Cell(3, 1).Range.Text = '方法'
    $table.Cell(3, 2).Range.Text = '質問紙調査と行動ログを組み合わせる。'
    $table.Cell(4, 1).Range.Text = '期待成果'
    $table.Cell(4, 2).Range.Text = '購買意欲に影響する要因を明らかにする。'
    $table.Rows.Item(1).Range.Bold = 1

    $selection.SetRange($document.Content.End - 1, $document.Content.End - 1)
    $selection.TypeParagraph()
    $selection.InsertBreak(7)
    $selection.Font.Size = 14
    $selection.Font.Bold = 1
    $selection.TypeText('2ページ目：改ページと箇条書き')
    $selection.TypeParagraph()
    $selection.Font.Size = 10.5
    $selection.Font.Bold = 0
    $selection.Range.ListFormat.ApplyBulletDefault()
    $selection.TypeText('レイアウトをMicrosoft Word本体で再現')
    $selection.TypeParagraph()
    $selection.TypeText('PDF化後も日本語フォントを維持')
    $selection.TypeParagraph()
    $selection.TypeText('Classroomの学生切替と採点欄を維持')
    $selection.Range.ListFormat.RemoveNumbers()

    $document.SaveAs2($target, 16)
    $document.Close(0)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    $document = $null
    Write-Output $target
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
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
