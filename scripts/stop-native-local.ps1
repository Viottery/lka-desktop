$ErrorActionPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
$pidFile = Join-Path $runtimeDir "native-app.pid"

$stopped = $false

if (Test-Path $pidFile) {
    $oldPidText = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $oldPid = 0
    if ([int]::TryParse($oldPidText, [ref]$oldPid)) {
        $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($oldProcess) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            $stopped = $true
            Write-Host "Stopped PID $oldPid"
        }
    }
}

try {
    Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            if ($_ -gt 0) {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
                $stopped = $true
                Write-Host "Stopped listener PID $_"
            }
        }
} catch {
    netstat -ano | Select-String "127.0.0.1:8000" | ForEach-Object {
        $parts = ($_ -split "\s+") | Where-Object { $_ }
        $pidText = $parts[-1]
        $pidValue = 0
        if ([int]::TryParse($pidText, [ref]$pidValue)) {
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
            $stopped = $true
            Write-Host "Stopped listener PID $pidValue"
        }
    }
}

if ($stopped) {
    Write-Host "Backend stopped."
} else {
    Write-Host "No backend process found."
}

exit 0
