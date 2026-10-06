<#
.SYNOPSIS
Start the native Windows LKA backend, frontend service and desktop pet.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-lka-native-windows.ps1
.EXAMPLE
.\run-lka-native-windows.ps1 -NoPet -OpenBrowser
.EXAMPLE
.\run-lka-native-windows.ps1 -BackendRoot 'C:\Projects\lka_backend'
.NOTES
Default ports: backend 8765, frontend 8780. Existing services started by this
script are reused when healthy. Other port owners are never stopped.
Logs and process records live in logs/ and .runtime/ under the frontend.
#>
[CmdletBinding()]
param(
    [string]$BackendRoot = (Join-Path $env:USERPROFILE 'projects\lka_backend'),
    [ValidateRange(1, 65535)][int]$BackendPort = 8765,
    [ValidateRange(1, 65535)][int]$FrontendPort = 8780,
    [string]$PetProfileId = 'truth-book-build',
    [ValidateRange(100, 4096)][int]$PetWidth = 360,
    [ValidateRange(100, 4096)][int]$PetHeight = 520,
    [switch]$NoPet,
    [switch]$OpenBrowser,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script with native Windows PowerShell.'
}
if ($BackendPort -eq $FrontendPort) { throw 'Backend and frontend ports must differ.' }
$frontendRoot = $PSScriptRoot
$BackendRoot = (Resolve-Path -LiteralPath $BackendRoot).ProviderPath
$backendPython = Join-Path $BackendRoot '.venv\Scripts\python.exe'
$frontendPython = Join-Path $frontendRoot '.venv\Scripts\python.exe'
$backendLauncher = Join-Path $BackendRoot 'scripts\start_backend.py'
$petLauncher = Join-Path $frontendRoot 'scripts\start-desktop-pet-java.ps1'
foreach ($path in @($backendPython, $frontendPython, $backendLauncher)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file is missing: $path. Prepare the project's native Windows environment first."
    }
}
if (-not $NoPet -and -not (Test-Path -LiteralPath $petLauncher -PathType Leaf)) {
    throw "Desktop pet launcher is missing: $petLauncher"
}
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"
$chatUrl = "$frontendUrl/desktop-pet/chat.html?backend=$([uri]::EscapeDataString($backendUrl))"
$runtimeDir = Join-Path $frontendRoot '.runtime'
$logsDir = Join-Path $frontendRoot 'logs'
New-Item -ItemType Directory -Force -Path $runtimeDir, $logsDir | Out-Null
$started = [System.Collections.Generic.List[object]]::new()

function Get-MessageControlToken {
    # Keep the control credential out of workspace config and browser/Java data.
    # DPAPI binds the persisted bytes to the current Windows user; only child
    # service environments receive the decrypted value.
    $configured = [Environment]::GetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($configured)) { return $configured }
    Add-Type -AssemblyName System.Security
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $identity = [Text.Encoding]::UTF8.GetBytes("$BackendRoot|$frontendRoot|$BackendPort|$FrontendPort")
        $digest = $sha.ComputeHash($identity)
        $installationId = ([BitConverter]::ToString($digest)).Replace('-', '').Substring(0, 24)
    } finally { $sha.Dispose() }
    $credentialDir = Join-Path $env:LOCALAPPDATA 'LKA\native-credentials'
    New-Item -ItemType Directory -Force -Path $credentialDir | Out-Null
    $credentialPath = Join-Path $credentialDir "$installationId-message-control.dpapi"
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if (Test-Path -LiteralPath $credentialPath -PathType Leaf) {
        $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [IO.File]::ReadAllBytes($credentialPath), $null, $scope)
    } else {
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $bytes = New-Object byte[] 32
            $random.GetBytes($bytes)
            $plain = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($bytes))
        } finally { $random.Dispose() }
        $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)
        $stream = [IO.File]::Open($credentialPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try { $stream.Write($protected, 0, $protected.Length) } finally { $stream.Dispose() }
    }
    $token = [Text.Encoding]::UTF8.GetString($plain)
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'The paired message control credential is invalid.' }
    return $token
}

$messageControlToken = Get-MessageControlToken

function Join-NativeArguments {
    param([string[]]$Values)
    # Start-Process joins ArgumentList without escaping. Quote each argument
    # using Windows argv rules, including quotes and trailing backslashes.
    return (($Values | ForEach-Object {
        $escaped = [regex]::Replace($_, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }) -join ' ')
}

function Get-RecordedProcess {
    param([string]$RecordPath, [string]$Root, [string]$Executable)
    if (-not (Test-Path -LiteralPath $RecordPath)) { return $null }
    try {
        $record = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
        if ($record.root -ne $Root -or $record.executable -ne $Executable) { return $null }
        $process = Get-Process -Id $record.process_id -ErrorAction Stop
        if ($process.Path -ne $Executable) { return $null }
        if ($process.StartTime.ToUniversalTime().ToString('o') -ne $record.started_at) { return $null }
        return $process
    } catch { return $null }
}

function Wait-Service {
    param($Process, [string]$Url, [string]$Name, [string]$ErrorLog)
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Name exited. See $ErrorLog" }
        try {
            $health = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 2
            if ($health.status -eq 'ok') {
                if ($Name -eq 'backend' -and $health.service -ne 'local-knowledge-agent-os') {
                    throw 'Unexpected backend health response.'
                }
                if ($Name -eq 'frontend') {
                    $page = Invoke-WebRequest -Uri "$Url/desktop-pet/chat.html" -UseBasicParsing -TimeoutSec 2
                    if ($page.StatusCode -ne 200) { throw 'Chat page is unavailable.' }
                }
                return
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw "$Name did not become healthy at $Url. See $ErrorLog"
}

function Start-NativeService {
    param([string]$Name, [string]$Root, [string]$Python, [string[]]$Arguments,
          [int]$Port, [string]$Url, [hashtable]$EnvironmentOverrides)
    $recordPath = Join-Path $runtimeDir "lka-native-$Name-$Port.json"
    $outLog = Join-Path $logsDir "lka-native-$Name-$Port.out.log"
    $errLog = Join-Path $logsDir "lka-native-$Name-$Port.err.log"
    $process = Get-RecordedProcess $recordPath $Root $Python
    if ($null -ne $process) {
        Wait-Service $process $Url $Name $errLog
        Write-Host "Reusing native $Name (PID $($process.Id)): $Url"
        return $process
    }
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners | Where-Object { $_.Port -eq $Port }) {
        throw "Port $Port is already in use. Stop that service yourself or choose another port; no process was stopped."
    }
    $previous = @{}
    try {
        foreach ($key in $EnvironmentOverrides.Keys) {
            $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $EnvironmentOverrides[$key], 'Process')
        }
        $process = Start-Process -FilePath $Python -ArgumentList (Join-NativeArguments $Arguments) `
            -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog -PassThru
    } finally {
        foreach ($key in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
        }
    }
    $entry = [pscustomobject]@{ process = $process; record = $recordPath; started_at = $process.StartTime.ToUniversalTime().ToString('o') }
    $started.Add($entry)
    @{ process_id = $process.Id; started_at = $entry.started_at; root = $Root; executable = $Python } |
        ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    Wait-Service $process $Url $Name $errLog
    Write-Host "Started native $Name (PID $($process.Id)): $Url"
    return $process
}

try {
    $backend = Start-NativeService -Name backend -Root $BackendRoot -Python $backendPython `
        -Arguments @($backendLauncher, 'personal', '--host', '127.0.0.1', '--port', "$BackendPort") `
        -Port $BackendPort -Url $backendUrl -EnvironmentOverrides @{
            PYTHONUTF8 = '1'; PYTHONIOENCODING = 'utf-8';
            LKA_DATA_DIR = (Join-Path $BackendRoot 'data\runtime');
            LKA_LOCAL_CONFIG = (Join-Path $BackendRoot 'config\local.toml');
            LKA_MESSAGES_CONTROL_TOKEN = $messageControlToken;
            LKA_CORS_ORIGINS = "http://127.0.0.1:$FrontendPort;http://localhost:$FrontendPort"
        }
    $frontendArguments = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$FrontendPort")
    $frontendEnvFile = Join-Path $frontendRoot '.env'
    if (Test-Path -LiteralPath $frontendEnvFile -PathType Leaf) {
        # Plugins read process environment directly, while Settings also reads
        # .env. Load it before app import so both receive the same local config.
        $frontendArguments += @('--env-file', $frontendEnvFile)
    }
    $frontend = Start-NativeService -Name frontend -Root $frontendRoot -Python $frontendPython `
        -Arguments $frontendArguments `
        -Port $FrontendPort -Url $frontendUrl -EnvironmentOverrides @{
            PYTHONUTF8 = '1'; PYTHONIOENCODING = 'utf-8'; LOCAL_RAG_ENABLED = 'false';
            LKA_MESSAGES_CONTROL_TOKEN = $messageControlToken
        }
} catch {
    # Roll back only services created by this invocation, never reused services.
    for ($index = $started.Count - 1; $index -ge 0; $index--) {
        $entry = $started[$index]
        $process = Get-Process -Id $entry.process.Id -ErrorAction SilentlyContinue
        if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $entry.started_at) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        }
        Remove-Item -LiteralPath $entry.record -Force -ErrorAction SilentlyContinue
    }
    throw
}

if (-not $NoPet) {
    $existingPet = Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains('SpinePetGdxLauncher') -and
            $_.CommandLine.Contains($frontendRoot) -and
            ($_.CommandLine.Contains([uri]::EscapeDataString($backendUrl)) -or $_.CommandLine.Contains($backendUrl)) }
    if ($existingPet) {
        Write-Host 'The desktop pet for this frontend/backend is already running.'
    } else {
        $petArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $petLauncher,
            '-NoServer', '-Spine', '-ProfileId', $PetProfileId, '-BaseUrl', $frontendUrl,
            '-BackendUrl', $backendUrl, '-Width', "$PetWidth", '-Height', "$PetHeight")
        $petProcess = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -ArgumentList (Join-NativeArguments $petArguments) -WorkingDirectory $frontendRoot `
            -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'lka-native-pet-launcher.out.log') `
            -RedirectStandardError (Join-Path $logsDir 'lka-native-pet-launcher.err.log') -PassThru
        Write-Host "Desktop pet launcher started (PID $($petProcess.Id))."
    }
}
Write-Host "Chat UI: $chatUrl"
Write-Host "Backend PID: $($backend.Id); frontend PID: $($frontend.Id)"
Write-Host "Logs: $logsDir\lka-native-*.log"
if (($OpenBrowser -or $NoPet) -and -not $NoOpen) { Start-Process $chatUrl }
