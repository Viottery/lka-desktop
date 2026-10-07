param(
    [string]$BackendRoot = "",
    [string]$BackendHost = "127.0.0.1",
    [int]$BackendPort = 8765,
    [string]$FrontendHost = "127.0.0.1",
    [int]$FrontendPort = 8780,
    [string]$WslDistro = "",
    [string]$PetProfileId = "truth-book-build",
    [int]$PetWidth = 360,
    [int]$PetHeight = 520,
    [switch]$NoBackend,
    [switch]$NoPet,
    [switch]$NoOpen,
    [switch]$OpenBrowser,
    [string]$MessageControlCredentialPath = ""
)

$ErrorActionPreference = "Stop"

# Resolve the selected WSL user's home before stopping any running services.
# Keep per-machine overrides in the environment or explicit launch arguments.
$wslBaseArgs = @()
if ($WslDistro.Trim()) {
    $wslBaseArgs += @("-d", $WslDistro.Trim())
}
if (-not $NoBackend) {
    $wslHome = (& wsl.exe @wslBaseArgs --exec /usr/bin/printenv HOME | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslHome.StartsWith("/") -or $wslHome.Contains("`n")) {
        throw "Could not resolve the selected WSL user's home directory."
    }
    if (-not $BackendRoot.Trim()) {
        $BackendRoot = if ($env:LKA_WSL_BACKEND_ROOT) { $env:LKA_WSL_BACKEND_ROOT } else { "$wslHome/lka_backend" }
    }
}

$projectRoot = $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
$logsDir = Join-Path $projectRoot "logs"
$backendPidFile = Join-Path $runtimeDir "lka-wsl-backend.pid"
$petServicePidFile = Join-Path $runtimeDir "lka-pet-service.pid"
$petLauncherPidFile = Join-Path $runtimeDir "lka-pet-java-launcher.pid"
$backendOut = Join-Path $logsDir "lka-wsl-backend.out.log"
$backendErr = Join-Path $logsDir "lka-wsl-backend.err.log"
$petServiceOut = Join-Path $logsDir "lka-pet-service.out.log"
$petServiceErr = Join-Path $logsDir "lka-pet-service.err.log"
$backendBaseUrl = "http://${BackendHost}:${BackendPort}"
$petBaseUrl = "http://${FrontendHost}:${FrontendPort}"
$chatUrl = "${petBaseUrl}/desktop-pet/chat.html?backend=${backendBaseUrl}"
$manifestUrl = "${petBaseUrl}/pet/manifest"

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
New-Item -ItemType Directory -Force $logsDir | Out-Null

function Stop-PidFileProcess {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return
    }
    $pidText = Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidValue = 0
    if ([int]::TryParse($pidText, [ref]$pidValue)) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
}

function Stop-ProjectJavaPet {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*SpinePetGdxLauncher*" -and
            $_.CommandLine -like "*$projectRoot*"
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Wait-HttpOk {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return $true
            }
        } catch {
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-ProjectPython {
    $pythonw = Join-Path $projectRoot ".venv\Scripts\pythonw.exe"
    $python = Join-Path $projectRoot ".venv\Scripts\python.exe"
    if (Test-Path $pythonw) {
        return $pythonw
    }
    if (Test-Path $python) {
        return $python
    }
    return "python"
}

function Start-WithoutMessageControlToken {
    param([scriptblock]$StartAction)
    $savedToken = [Environment]::GetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', $null, 'Process')
        & $StartAction
    } finally {
        [Environment]::SetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', $savedToken, 'Process')
    }
}

# Pair only the local Python adapter; credentials never become Java arguments.
$messageControlToken = [Environment]::GetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', 'Process')
if ([string]::IsNullOrWhiteSpace($messageControlToken)) {
    $explicitCredential = -not [string]::IsNullOrWhiteSpace($MessageControlCredentialPath)
    if (-not $explicitCredential) {
        $MessageControlCredentialPath = Join-Path $runtimeDir 'message-control.dpapi'
    }
    if (Test-Path -LiteralPath $MessageControlCredentialPath -PathType Leaf) {
        Add-Type -AssemblyName System.Security
        $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [IO.File]::ReadAllBytes($MessageControlCredentialPath), $null,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $messageControlToken = [Text.Encoding]::UTF8.GetString($plain)
        $plain = $null
        if ([string]::IsNullOrWhiteSpace($messageControlToken)) {
            throw 'The paired message control credential is invalid.'
        }
    } elseif ($explicitCredential) {
        throw 'The specified message control credential file is missing.'
    }
}

Stop-PidFileProcess $petServicePidFile
Stop-PidFileProcess $petLauncherPidFile
Stop-ProjectJavaPet

if (-not $NoBackend) {
    Stop-PidFileProcess $backendPidFile

    $wslArgs = @($wslBaseArgs)
    $wslArgs += @(
        "--cd", $BackendRoot,
        "--exec",
        "/usr/bin/env",
        "PATH=${wslHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "UV_CACHE_DIR=/tmp/uv-cache",
        "LKA_HOST=$BackendHost",
        "LKA_PORT=$BackendPort",
        "${wslHome}/.local/bin/uv",
        "run",
        "python",
        "-m",
        "uvicorn",
        "app.api.main:app",
        "--host",
        $BackendHost,
        "--port",
        "$BackendPort"
    )

    Write-Host "Starting WSL backend: $backendBaseUrl"
    $backendProcess = Start-WithoutMessageControlToken {
        Start-Process `
            -FilePath "wsl.exe" `
            -ArgumentList $wslArgs `
            -WindowStyle Hidden `
            -RedirectStandardOutput $backendOut `
            -RedirectStandardError $backendErr `
            -PassThru
    }
    Set-Content -Path $backendPidFile -Value $backendProcess.Id -Encoding ASCII
}

Write-Host "Starting Windows pet service: $petBaseUrl"
$petPython = Get-ProjectPython
$petServiceArgs = @("-m", "uvicorn", "app.main:app", "--host", $FrontendHost, "--port", "$FrontendPort")
$frontendEnvPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $frontendEnvPath -PathType Leaf) {
    $petServiceArgs += @("--env-file", ('"' + $frontendEnvPath + '"'))
}
$previousControlToken = [Environment]::GetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', 'Process')
try {
    if (-not [string]::IsNullOrWhiteSpace($messageControlToken)) {
        [Environment]::SetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', $messageControlToken, 'Process')
    }
    $petServiceProcess = Start-Process `
        -FilePath $petPython `
        -ArgumentList $petServiceArgs `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $petServiceOut `
        -RedirectStandardError $petServiceErr `
        -PassThru
} finally {
    [Environment]::SetEnvironmentVariable('LKA_MESSAGES_CONTROL_TOKEN', $previousControlToken, 'Process')
    $messageControlToken = $null
}
Set-Content -Path $petServicePidFile -Value $petServiceProcess.Id -Encoding ASCII

if (-not (Wait-HttpOk -Url "$backendBaseUrl/health" -TimeoutSeconds 45)) {
    Write-Warning "Backend health check did not pass within timeout. Check: $backendErr"
} else {
    Write-Host "Backend health OK: $backendBaseUrl/health"
}

if (-not (Wait-HttpOk -Url $manifestUrl -TimeoutSeconds 20)) {
    Write-Warning "Pet service did not become ready within timeout. Check: $petServiceErr"
} else {
    Write-Host "Pet service OK: $manifestUrl"
}

if (-not $NoPet) {
    $petLauncher = Join-Path $projectRoot "scripts\start-desktop-pet-java.ps1"
    if (-not (Test-Path $petLauncher)) {
        throw "Java pet launcher not found: $petLauncher"
    }

    Write-Host "Starting Java Spine pet profile: $PetProfileId"
    $petLaunchProcess = Start-WithoutMessageControlToken {
        Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $petLauncher, "-NoServer", "-Spine", "-ProfileId", $PetProfileId, "-BaseUrl", $petBaseUrl, "-BackendUrl", $backendBaseUrl, "-Width", "$PetWidth", "-Height", "$PetHeight") `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -PassThru
    }
    Set-Content -Path $petLauncherPidFile -Value $petLaunchProcess.Id -Encoding ASCII
}

Write-Host "Chat UI: $chatUrl"
Write-Host "Pet panel: ${petBaseUrl}/desktop-pet/?mode=panel"
Write-Host "Backend log: $backendOut"
Write-Host "Pet service log: $petServiceOut"

if ($OpenBrowser -and -not $NoOpen) {
    Start-Process $chatUrl
}
