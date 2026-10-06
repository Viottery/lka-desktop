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

function Get-JavaHomeFromJavaCmd {
    if (-not (Test-CommandExists "java")) {
        return $null
    }
    $javaCmd = (Get-Command java).Source
    $binPath = Split-Path -Parent $javaCmd
    return Split-Path -Parent $binPath
}

Refresh-PathFromRegistry

if (-not (Test-CommandExists "java")) {
    if (-not $InstallPrereqs) {
        throw "Java not found. Re-run with -InstallPrereqs to install Temurin 21 automatically."
    }
    if (-not (Test-CommandExists "winget")) {
        throw "winget is required for automatic Java install. Install Java 21 manually and retry."
    }

    Write-Host "Installing Temurin 21 JDK via winget..."
    winget install -e --id EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
    Refresh-PathFromRegistry
}

if (-not (Test-CommandExists "java")) {
    throw "Java installation finished but java command is still unavailable in this shell. Open a new PowerShell and run again."
}

$javaHome = Get-JavaHomeFromJavaCmd
if ($javaHome) {
    $env:JAVA_HOME = $javaHome
}

Write-Host "Java environment is ready."
java -version
Write-Host "JAVA_HOME=$env:JAVA_HOME"
