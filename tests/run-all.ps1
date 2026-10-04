# Test runner for agent-delegation-tools test suite
# Runs every tests/*.Tests.ps1, prints per-file results, and exits non-zero on any failure.

[CmdletBinding()]
param(
    [string[]]$Filter
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$testsDir = $PSScriptRoot
if (-not $testsDir) { $testsDir = (Get-Location).ProviderPath }

$testFiles = Get-ChildItem -LiteralPath $testsDir -Filter '*.Tests.ps1' -File | Sort-Object Name
if ($Filter -and $Filter.Count -gt 0) {
    $testFiles = @($testFiles | Where-Object {
        $name = $_.Name
        $matchesAny = $false
        foreach ($f in $Filter) {
            if ($name -like "*$f*") { $matchesAny = $true; break }
        }
        $matchesAny
    })
}

if ($testFiles.Count -eq 0) {
    Write-Host "No test files matching criteria in $testsDir" -ForegroundColor Yellow
    exit 0
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Running agent-delegation-tools Tests   " -ForegroundColor Cyan
Write-Host " Found $($testFiles.Count) test file(s) " -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$savedDelegationDepth = $env:AGENT_DELEGATION_DEPTH
Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue

$results = [System.Collections.Generic.List[PSObject]]::new()
$overallSw = [System.Diagnostics.Stopwatch]::StartNew()

try {
    foreach ($file in $testFiles) {
        $fileName = $file.Name
        Write-Host "--> Running $fileName..." -NoNewline

        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file.FullName 2>&1)
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $prevEap
        }
        $sw.Stop()
        $duration = "{0:N2}s" -f $sw.Elapsed.TotalSeconds

        if ($exitCode -eq 0) {
            Write-Host "`r[PASS] $fileName ($duration)    " -ForegroundColor Green
            $results.Add([PSCustomObject]@{
                File = $fileName
                Status = 'PASS'
                ExitCode = 0
                Duration = $duration
                Output = $output
            })
        }
        else {
            Write-Host "`r[FAIL] $fileName (exit $exitCode, $duration)    " -ForegroundColor Red
            if ($output) {
                Write-Host ($output -join [Environment]::NewLine) -ForegroundColor DarkRed
            }
            $results.Add([PSCustomObject]@{
                File = $fileName
                Status = 'FAIL'
                ExitCode = $exitCode
                Duration = $duration
                Output = $output
            })
        }
    }
}
finally {
    if ($savedDelegationDepth) {
        $env:AGENT_DELEGATION_DEPTH = $savedDelegationDepth
    }
}

$overallSw.Stop()
$totalCount = $results.Count
$passCount = @($results | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Test Run Summary ($("{0:N2}s" -f $overallSw.Elapsed.TotalSeconds))" -ForegroundColor Cyan
Write-Host " Total : $totalCount" -ForegroundColor Cyan
Write-Host " Passed: $passCount" -ForegroundColor $(if ($passCount -eq $totalCount) { 'Green' } else { 'Yellow' })
Write-Host " Failed: $failCount" -ForegroundColor $(if ($failCount -gt 0) { 'Red' } else { 'Green' })
Write-Host "========================================" -ForegroundColor Cyan

if ($failCount -gt 0) {
    Write-Host "`nFailed tests:" -ForegroundColor Red
    foreach ($r in ($results | Where-Object { $_.Status -eq 'FAIL' })) {
        Write-Host "  - $($r.File) (exit $($r.ExitCode))" -ForegroundColor Red
    }
    exit 1
}

exit 0
