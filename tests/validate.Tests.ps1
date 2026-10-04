# Smoke test for validate.ps1
$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$validator = Join-Path $repoRoot 'validate.ps1'
Assert-True (Test-Path -LiteralPath $validator -PathType Leaf) "validate.ps1 not found at $validator"

$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("validate-smoke-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $reportFile = Join-Path $testRoot 'validation-report.json'

    # Isolate personal-install checks from the real host configuration.
    $savedProfile = $env:USERPROFILE
    $savedCodexHome = $env:CODEX_HOME
    $env:USERPROFILE = $testRoot
    $env:CODEX_HOME = Join-Path $testRoot 'codex-home'

    # Run validate.ps1 with -SkipLiveProbes and -ReportPath
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator -SkipLiveProbes -ReportPath $reportFile
    Assert-Equal 0 $LASTEXITCODE "validate.ps1 -SkipLiveProbes failed with exit code $LASTEXITCODE."
    Assert-True (Test-Path -LiteralPath $reportFile -PathType Leaf) "Report file was not generated: $reportFile"

    $report = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $failures = @($report | Where-Object { $_.Status -eq 'Fail' })
    $passes = @($report | Where-Object { $_.Status -eq 'Pass' })
    Assert-Equal 0 $failures.Count "validate.ps1 reported failures: $($failures.Count)"
    Assert-True ($passes.Count -gt 0) "validate.ps1 did not record any passes: $($passes.Count)"

    'validate.Tests.ps1: all tests passed.'
}
finally {
    $env:USERPROFILE = $savedProfile
    $env:CODEX_HOME = $savedCodexHome
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
