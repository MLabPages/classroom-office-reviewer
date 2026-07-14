$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false

$script:word = $null
$script:document = $null
$script:openPath = $null

function Write-Response([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

function Release-Object($Value) {
    if ($null -ne $Value) {
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) } catch {}
    }
}

function Close-CurrentDocument {
    $closedPath = $script:openPath
    if ($null -ne $script:document) {
        try { $script:document.Close(0) } catch {}
        Release-Object $script:document
        $script:document = $null
    }
    $script:openPath = $null
    return $closedPath
}

function Stop-WordApplication {
    $closedPath = Close-CurrentDocument
    if ($null -ne $script:word) {
        try { $script:word.Quit() } catch {}
        Release-Object $script:word
        $script:word = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    return $closedPath
}

function Ensure-WordApplication {
    if ($null -ne $script:word) {
        try {
            $null = $script:word.Version
            return
        } catch {
            Release-Object $script:word
            $script:word = $null
        }
    }
    $script:word = New-Object -ComObject Word.Application
    $script:word.Visible = $true
    $script:word.DisplayAlerts = 0
    $script:word.AutomationSecurity = 3
}

try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            switch ([string]$request.action) {
                'open' {
                    $closedPath = Close-CurrentDocument
                    Ensure-WordApplication
                    $targetPath = [System.IO.Path]::GetFullPath([string]$request.path)
                    $script:document = $script:word.Documents.Open($targetPath, $false, $true, $false)
                    $script:openPath = $targetPath
                    $script:word.Visible = $true
                    [void]$script:document.Activate()
                    [void]$script:word.Activate()
                    try { $script:word.ActiveWindow.View.Type = 3 } catch {}
                    try { $script:word.ActiveWindow.View.Zoom.PageFit = 1 } catch {}
                    Write-Response @{ id = [string]$request.id; ok = $true; closedPath = $closedPath }
                }
                'close' {
                    $closedPath = Stop-WordApplication
                    Write-Response @{ id = [string]$request.id; ok = $true; closedPath = $closedPath }
                }
                'quit' {
                    $closedPath = Stop-WordApplication
                    Write-Response @{ id = [string]$request.id; ok = $true; closedPath = $closedPath }
                    break
                }
                default {
                    throw 'Unknown action.'
                }
            }
            if ([string]$request.action -eq 'quit') { break }
        } catch {
            $requestId = if ($null -ne $request) { [string]$request.id } else { '' }
            Write-Response @{ id = $requestId; ok = $false; error = $_.Exception.Message }
        }
    }
}
finally {
    [void](Stop-WordApplication)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
