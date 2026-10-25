param(
    [switch]$InstallPrereqs
)

$ErrorActionPreference = "Stop"

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-PathFromRegistry {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($machinePath -and $userPath) {
        $env:Path = "$machinePath;$userPath"
    } elseif ($machinePath) {
        $env:Path = $machinePath
    } elseif ($userPath) {
        $env:Path = $userPath
    }
}

function Test-Java21Home {
    param([string]$HomePath)
    if (-not $HomePath) { return $false }
    $java = Join-Path $HomePath "bin\java.exe"
    $javac = Join-Path $HomePath "bin\javac.exe"
    if (-not (Test-Path -LiteralPath $java) -or -not (Test-Path -LiteralPath $javac)) { return $false }
    try {
        # Windows PowerShell wraps native stderr as ErrorRecord even on success.
        $ErrorActionPreference = "Continue"
        $version = & $java -version 2>&1 | Out-String
        return $LASTEXITCODE -eq 0 -and $version -match 'version "21(?:[."]|$)'
    } catch { return $false }
}

# Preserve a valid portable JDK even when it is absent from registry PATH.
$javaHome = $env:JAVA_HOME
if (-not (Test-Java21Home $javaHome)) {
    Refresh-PathFromRegistry
    $javaHome = $null
    if (Test-CommandExists "java") {
        $candidate = Split-Path -Parent (Split-Path -Parent (Get-Command java).Source)
        if (Test-Java21Home $candidate) { $javaHome = $candidate }
    }
    if (-not $javaHome) {
        if (-not $InstallPrereqs) {
            throw "A Java 21 JDK is required. Set JAVA_HOME to an existing JDK or re-run with -InstallPrereqs."
        }
        if (-not (Test-CommandExists "winget")) {
            throw "winget is required for automatic Java install. Install Java 21 manually and retry."
        }
        Write-Host "Installing Temurin 21 JDK via winget..."
        winget install -e --id EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "Java installation failed." }
        Refresh-PathFromRegistry
        if (Test-CommandExists "java") {
            $candidate = Split-Path -Parent (Split-Path -Parent (Get-Command java).Source)
            if (Test-Java21Home $candidate) { $javaHome = $candidate }
        }
    }
}
if (-not $javaHome) { throw "Java 21 JDK is still unavailable. Set JAVA_HOME and retry." }
$env:JAVA_HOME = $javaHome
$env:Path = (Join-Path $javaHome "bin") + ";" + $env:Path
Write-Host "Java environment is ready."
Write-Host "JAVA_HOME=$env:JAVA_HOME"
