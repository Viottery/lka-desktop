param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [switch]$NoServer,
    [switch]$NoOpen,
    [switch]$Static,
    [switch]$WebLayer,
    [switch]$Spine,
    [string]$ProfileId = "",
    [string]$BackendUrl = "http://127.0.0.1:8765",
    [int]$Width = 360,
    [int]$Height = 520
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$javaProject = Join-Path $projectRoot "desktop-pet-java"
$setupScript = Join-Path $projectRoot "scripts\setup-java-env.ps1"
$launcher = Join-Path $projectRoot "run-native-local.ps1"
$javaGradle = Join-Path $javaProject "gradlew.bat"
$javaOutLog = Join-Path $projectRoot "logs\desktop-pet-java.out.log"
$javaErrLog = Join-Path $projectRoot "logs\desktop-pet-java.err.log"
$profilesPath = Join-Path $projectRoot "data\pet\profiles.json"
$statePath = Join-Path $projectRoot "data\pet\state.json"

if (-not (Test-Path $javaProject)) {
    throw "Java desktop pet project not found: $javaProject"
}
if (-not (Test-Path $javaGradle)) {
    throw "Gradle wrapper not found: $javaGradle"
}

& $setupScript | Out-Host
if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    $env:Path = (Join-Path $env:JAVA_HOME "bin") + ";" + $env:Path
}

if (-not $NoServer) {
    if (-not (Test-Path $launcher)) {
        throw "Native launcher not found: $launcher"
    }
    & $launcher | Out-Host
    Start-Sleep -Seconds 2
}

if (-not $NoOpen) {
    New-Item -ItemType Directory -Force -Path (Split-Path $javaOutLog) | Out-Null

    if ($Spine) {
        if (-not (Test-Path $profilesPath)) {
            throw "profiles.json not found: $profilesPath"
        }

        $profiles = Get-Content -Raw -LiteralPath $profilesPath | ConvertFrom-Json
        $state = $null
        if (Test-Path $statePath) {
            try {
                $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            } catch {
                $state = $null
            }
        }

        $targetProfileId = if ($ProfileId) {
            $ProfileId
        } elseif ($state -and $state.active_profile_id) {
            [string]$state.active_profile_id
        } elseif ($profiles.Count -gt 0) {
            [string]$profiles[0].id
        } else {
            ""
        }

        $profile = $profiles | Where-Object { $_.id -eq $targetProfileId } | Select-Object -First 1
        if (-not $profile) {
            throw "Spine profile not found: $targetProfileId"
        }
        if (-not $profile.spine -or -not $profile.spine.skeleton_url -or -not $profile.spine.atlas_url) {
            throw "Profile has no valid spine asset config: $targetProfileId"
        }

        $idleAnimation = if ($profile.spine.animation_map -and $profile.spine.animation_map.idle) {
            [string]$profile.spine.animation_map.idle
        } else {
            [string]$profile.default_animation
        }

        $skeletonScale = if ($profile.spine.skeleton_scale) { [string]$profile.spine.skeleton_scale } else { "0.52" }
        $xOffset = if ($null -ne $profile.spine.x_offset) { [string]$profile.spine.x_offset } else { "0" }
        $floorOffset = if ($null -ne $profile.spine.floor_offset) { [string]$profile.spine.floor_offset } else { "24" }
        $panelUrl = "$($BaseUrl.TrimEnd('/'))/desktop-pet/?mode=panel"
        $chatUrl = "$($BaseUrl.TrimEnd('/'))/desktop-pet/chat.html?backend=$([uri]::EscapeDataString($BackendUrl.TrimEnd('/')))"

        $argsLine = "--profile-id=$targetProfileId --skeleton-url=$($profile.spine.skeleton_url) --atlas-url=$($profile.spine.atlas_url) --animation=$idleAnimation --panel-url=$panelUrl --chat-url=$chatUrl --width=$Width --height=$Height --skeleton-scale=$skeletonScale --x-offset=$xOffset --floor-offset=$floorOffset"

        $process = Start-Process `
            -FilePath $javaGradle `
            -WorkingDirectory $javaProject `
            -ArgumentList "runSpine --args=""$argsLine""" `
            -WindowStyle Hidden `
            -RedirectStandardOutput $javaOutLog `
            -RedirectStandardError $javaErrLog `
            -PassThru

        Write-Host "Desktop pet Java Spine launcher PID: $($process.Id)"
        Write-Host "Desktop pet Java Spine profile: $targetProfileId"
    }
    else {
        $modeArg = if ($WebLayer -and -not $Static) { "--web-layer" } else { "--static" }
        $argsLine = "--base-url=$($BaseUrl.TrimEnd('/')) --width=$Width --height=$Height $modeArg"

        $process = Start-Process `
            -FilePath $javaGradle `
            -WorkingDirectory $javaProject `
            -ArgumentList "run --args=""$argsLine""" `
            -WindowStyle Hidden `
            -RedirectStandardOutput $javaOutLog `
            -RedirectStandardError $javaErrLog `
            -PassThru

        Write-Host "Desktop pet Java launcher PID: $($process.Id)"
        Write-Host "Desktop pet Java mode: $modeArg"
    }

    Write-Host "Desktop pet Java stdout: $javaOutLog"
    Write-Host "Desktop pet Java stderr: $javaErrLog"
}

Write-Host "Java desktop pet layer URL: $($BaseUrl.TrimEnd('/'))/desktop-pet/?layer=1"
Write-Host "Java desktop pet panel URL: $($BaseUrl.TrimEnd('/'))/desktop-pet/?mode=panel"
