$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false

$script:powerPoint = $null
$script:presentation = $null
$script:slideShowWindow = $null
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

function Close-CurrentPresentation {
    $closedPath = $script:openPath
    if ($null -ne $script:slideShowWindow) {
        try { $script:slideShowWindow.View.Exit() } catch {}
        Release-Object $script:slideShowWindow
        $script:slideShowWindow = $null
    }
    if ($null -ne $script:presentation) {
        try { $script:presentation.Close() } catch {}
        Release-Object $script:presentation
        $script:presentation = $null
    }
    $script:openPath = $null
    return $closedPath
}

function Stop-PowerPointApplication {
    $closedPath = Close-CurrentPresentation
    if ($null -ne $script:powerPoint) {
        try { $script:powerPoint.Quit() } catch {}
        Release-Object $script:powerPoint
        $script:powerPoint = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    return $closedPath
}

function Ensure-PowerPointApplication {
    if ($null -ne $script:powerPoint) {
        try {
            $null = $script:powerPoint.Version
            return
        } catch {
            Release-Object $script:powerPoint
            $script:powerPoint = $null
        }
    }
    $script:powerPoint = New-Object -ComObject PowerPoint.Application
    $script:powerPoint.Visible = -1
    $script:powerPoint.DisplayAlerts = 1
    $script:powerPoint.AutomationSecurity = 3
}

try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            switch ([string]$request.action) {
                'open' {
                    $closedPath = Close-CurrentPresentation
                    Ensure-PowerPointApplication
                    $targetPath = [System.IO.Path]::GetFullPath([string]$request.path)
                    $script:presentation = $script:powerPoint.Presentations.Open($targetPath, $true, $false, $true)
                    $script:openPath = $targetPath
                    $slideShowSettings = $script:presentation.SlideShowSettings
                    $slideShowSettings.ShowType = 1
                    $script:slideShowWindow = $slideShowSettings.Run()
                    Release-Object $slideShowSettings
                    Write-Response @{ id = [string]$request.id; ok = $true; closedPath = $closedPath }
                }
                'quit' {
                    $closedPath = Stop-PowerPointApplication
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
    [void](Stop-PowerPointApplication)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
