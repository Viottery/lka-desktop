param([string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$python = Join-Path $root '.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Create the native frontend Python environment first.' }
if ([string]::IsNullOrWhiteSpace($JavaHome)) { throw 'Pass -JavaHome pointing to an installed Java 21 JDK, or set JAVA_HOME.' }
$env:JAVA_HOME = $JavaHome
$ready = [IO.Path]::GetTempFileName()
$out = [IO.Path]::GetTempFileName()
$err = [IO.Path]::GetTempFileName()
$port = $null
$process = $null
Push-Location $root
try {
    $fixture = Join-Path $root 'tests\native_upload_test_server.py'
    $process = Start-Process -FilePath $python -ArgumentList @(('"' + $fixture + '"'), '--ready-file', ('"' + $ready + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    for ($i = 0; $i -lt 100; $i++) {
        if ((Get-Item $ready).Length -gt 0) { break }
        $process.Refresh()
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    $port = (Get-Content -Raw $ready).Trim()
    if ($port -notmatch '^\d{2,5}$') {
        Get-Content $err
        throw 'Synthetic ASGI server failed to start.'
    }
    & .\desktop-pet-java\gradlew.bat -p desktop-pet-java --offline --console=plain previewQuickConversation ("-PfrontendRoot=" + (Join-Path $root 'app\web\pet')) -PbinaryUploadOnly=true ("-PbinaryUploadBackend=http://127.0.0.1:" + $port)
    $testExit = $LASTEXITCODE
    Get-Content $out
    Get-Content $err
    if ($testExit -ne 0) { throw 'Native ASGI upload regression failed.' }
} finally {
    if ($port -match '^\d{2,5}$') {
        try { Invoke-RestMethod ("http://127.0.0.1:" + $port + '/_test/shutdown') -Method Post -TimeoutSec 3 | Out-Null } catch { Write-Warning 'Synthetic upload server shutdown request failed.' }
    }
    if ($process) { $null = $process.WaitForExit(5000) }
    Remove-Item $ready, $out, $err -Force -ErrorAction SilentlyContinue
    Pop-Location
}
