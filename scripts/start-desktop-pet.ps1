param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [switch]$NoServer,
    [switch]$NoOpen,
    [switch]$Browser,
    [switch]$WebView,
    [switch]$Static,
    [int]$Width = 360,
    [int]$Height = 520
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "run-native-local.ps1"
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$pythonw = Join-Path $projectRoot ".venv\Scripts\pythonw.exe"
$petUrl = "$($BaseUrl.TrimEnd('/'))/desktop-pet/?layer=1"
$browserUrl = "$($BaseUrl.TrimEnd('/'))/desktop-pet/"

if (-not $NoServer) {
    if (-not (Test-Path $launcher)) {
        throw "Native launcher not found: $launcher"
    }
    & $launcher | Out-Host
    Start-Sleep -Seconds 2
}

if (-not $NoOpen) {
    if ($Browser) {
        Start-Process $browserUrl
    } else {
        if (-not (Test-Path $python)) {
            throw "Virtual environment Python not found: $python"
        }
        $windowPython = if (Test-Path $pythonw) { $pythonw } else { $python }
        if ($WebView) {
            Start-Process `
                -FilePath $windowPython `
                -WorkingDirectory $projectRoot `
                -ArgumentList @("-m", "app.pet.desktop_window", "--url", $petUrl, "--width", "$Width", "--height", "$Height") `
                -WindowStyle Hidden
        } elseif (-not $Static) {
            $qtCheck = Start-Process `
                -FilePath $python `
                -WorkingDirectory $projectRoot `
                -ArgumentList '-c "import PyQt6.QtWebEngineWidgets"' `
                -Wait `
                -PassThru `
                -WindowStyle Hidden
            if ($qtCheck.ExitCode -eq 0) {
                Start-Process `
                    -FilePath $windowPython `
                    -WorkingDirectory $projectRoot `
                    -ArgumentList @("-m", "app.pet.qt_spine_window", "--base-url", $BaseUrl, "--width", "$Width", "--height", "$Height") `
                    -WindowStyle Hidden
            } else {
                Write-Warning "PyQt6-WebEngine is not installed; falling back to the static native pet. Install requirements-windows-agent.txt to enable Spine animation."
                Start-Process `
                    -FilePath $windowPython `
                    -WorkingDirectory $projectRoot `
                    -ArgumentList @("-m", "app.pet.native_window", "--base-url", $BaseUrl, "--width", "$Width", "--height", "$Height") `
                    -WindowStyle Hidden
            }
        } else {
            Start-Process `
                -FilePath $windowPython `
                -WorkingDirectory $projectRoot `
                -ArgumentList @("-m", "app.pet.native_window", "--base-url", $BaseUrl, "--width", "$Width", "--height", "$Height") `
                -WindowStyle Hidden
        }
    }
}

Write-Host "Spine desktop pet uses: $($BaseUrl.TrimEnd('/'))/desktop-pet/?layer=1"
Write-Host "Static native fallback uses: $($BaseUrl.TrimEnd('/'))/pet/*"
Write-Host "WebView fallback URL: $petUrl"
Write-Host "Browser fallback URL: $browserUrl"
