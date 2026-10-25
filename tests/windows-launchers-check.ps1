param([string]$JavaHome)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
# Extract only the pure comparison helper: never execute launcher startup code.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $root 'run-lka-native-windows.ps1'), [ref]$tokens, [ref]$errors)
Assert-True ($errors.Count -eq 0) 'Launcher PowerShell syntax errors'
$helper = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ProcessStartTime'
}, $true)
Invoke-Expression $helper.Extent.Text
$actual = [DateTime]::Parse('2026-10-24T03:04:05.1234567Z', [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind)
foreach ($json in @('{"started_at":"2026-10-24T03:04:05.1234567Z"}',
                    '{"started_at":"2026-10-24T11:04:05.1234567+08:00"}')) {
    $record = $json | ConvertFrom-Json
    Assert-True (Test-ProcessStartTime $actual $record.started_at) 'JSON timestamp roundtrip failed'
}
Assert-True (Test-ProcessStartTime $actual $actual.ToLocalTime()) 'DateTime local comparison failed'
Assert-True (-not (Test-ProcessStartTime $actual $actual.AddTicks(1))) 'PID reuse timestamp mismatch accepted'
Assert-True (-not (Test-ProcessStartTime $actual 'invalid')) 'Malformed timestamp accepted'
Assert-True (-not (Test-ProcessStartTime $actual $null)) 'Missing timestamp accepted'
if ($JavaHome) {
    $oldHome = $env:JAVA_HOME
    $oldPath = $env:Path
    try {
        $env:JAVA_HOME = $JavaHome
        $env:Path = "$env:SystemRoot\System32"
        # A valid portable JAVA_HOME must avoid the registry refresh entirely.
        & (Join-Path $root 'scripts/setup-java-env.ps1')
        Assert-True ($env:JAVA_HOME -eq $JavaHome) 'Portable JAVA_HOME overwritten'
        Assert-True ($env:Path.StartsWith((Join-Path $JavaHome 'bin') + ';')) 'JDK bin not prepended'
    } finally {
        $env:JAVA_HOME = $oldHome
        $env:Path = $oldPath
    }
}
Write-Host "Windows launcher checks passed on PowerShell $($PSVersionTable.PSVersion)."
