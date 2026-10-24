param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Run this entry with native Windows PowerShell.'
    }
    # Run outside .venv so pip/uv can update it without locking its Python DLLs.
    $venvPython = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        throw 'Complete the initial Windows installation before checking for updates.'
    }
    $basePython = (& $venvPython -c 'import sys; print(sys._base_executable)' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $basePython)) {
        throw 'Could not locate the base Windows Python interpreter.'
    }
    $env:PYTHONUTF8 = '1'
    $arguments = @((Join-Path $PSScriptRoot 'update_lka.py'), '--root', $root)
    if (-not $CheckOnly) { $arguments += '--apply' }
    & $basePython @arguments
    exit $LASTEXITCODE
} catch {
    Write-Host ('Update stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
