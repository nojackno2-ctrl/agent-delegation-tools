$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-ParallelTest {
    param(
        [Parameter(Mandatory = $true)][string]$Wrapper,
        [Parameter(Mandatory = $true)][string]$TaskFile,
        [Parameter(Mandatory = $true)][string]$ResultsDir,
        [int]$TaskTimeoutSec = 10,
        [int]$MaxConcurrency = 2
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Wrapper `
            -TaskFile $TaskFile -ResultsDir $ResultsDir -DelegatePath $script:fakeDelegate `
            -WorkDir $script:workDir -ChildTimeoutSec 10 -TaskTimeoutSec $TaskTimeoutSec `
            -MaxConcurrency $MaxConcurrency -Json 2>&1)
        return [pscustomobject]@{ ExitCode=$LASTEXITCODE; Output=$output }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$canonicalWrapper = if ($env:TEST_PARALLEL_WRAPPER) {
    [IO.Path]::GetFullPath($env:TEST_PARALLEL_WRAPPER)
}
else {
    Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\parallel.ps1'
}
$compatibilityWrapper = Join-Path $repositoryRoot 'parallel.ps1'
$script:fakeDelegate = Join-Path $PSScriptRoot 'fixtures\fake-delegate.ps1'
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $safeTempRoot ("parallel-wrapper-{0}" -f [Guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $script:workDir = Join-Path $testRoot 'workspace'
    $barrierDir = Join-Path $testRoot 'barrier'
    New-Item -ItemType Directory -Path $script:workDir, $barrierDir | Out-Null
    $env:FAKE_PARALLEL_BARRIER_DIR = $barrierDir
    $utf8NoBom = New-Object Text.UTF8Encoding($false)

    $parallelTasks = @(
        [ordered]@{ name='alpha'; prompt=(@{name='alpha';waitFor=@('alpha','beta')} | ConvertTo-Json -Compress); agent='agy' },
        [ordered]@{ name='beta'; prompt=(@{name='beta';waitFor=@('alpha','beta')} | ConvertTo-Json -Compress); agent='claude' }
    )
    $parallelTaskFile = Join-Path $testRoot 'parallel-tasks.json'
    [IO.File]::WriteAllText($parallelTaskFile, ($parallelTasks | ConvertTo-Json -Depth 5), $utf8NoBom)
    $parallelResults = Join-Path $testRoot 'parallel-results'
    $parallel = Invoke-ParallelTest -Wrapper $canonicalWrapper -TaskFile $parallelTaskFile -ResultsDir $parallelResults
    Assert-Equal 0 $parallel.ExitCode ('Concurrent batch failed: ' + ($parallel.Output -join [Environment]::NewLine))
    $summary = [IO.File]::ReadAllText((Join-Path $parallelResults 'summary.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Equal 2 $summary.total 'Summary total is wrong.'
    Assert-Equal 2 $summary.succeeded 'Both barrier tasks should succeed only when they overlap.'
    Assert-Equal 'alpha' $summary.tasks[0].name 'Summary should retain task-file order.'
    Assert-Equal 'beta' $summary.tasks[1].name 'Summary should retain task-file order.'
    Assert-Equal 'result:alpha' ([IO.File]::ReadAllText($summary.tasks[0].finalFile, [Text.Encoding]::UTF8)) 'Alpha final output was not isolated.'
    Assert-Equal 'raw:alpha' ([IO.File]::ReadAllText($summary.tasks[0].rawFile, [Text.Encoding]::UTF8)) 'Alpha raw output was not isolated.'
    Assert-Equal 'stdout:beta' ([IO.File]::ReadAllText($summary.tasks[1].stdoutFile, [Text.Encoding]::UTF8)) 'Beta stdout was not isolated.'
    Assert-True (Test-Path -LiteralPath $summary.tasks[1].resultFile -PathType Leaf) 'Per-task result metadata file is missing.'

    $implementationTasks = @(
        [ordered]@{ name='writer'; prompt=(@{name='writer';expectedSandbox='workspace-write'} | ConvertTo-Json -Compress); agent='codex'; taskType='implementation'; writeScope=@('src\writer') }
    )
    $implementationTaskFile = Join-Path $testRoot 'implementation-tasks.json'
    [IO.File]::WriteAllText($implementationTaskFile, ($implementationTasks | ConvertTo-Json -Depth 5), $utf8NoBom)
    $implementationResults = Join-Path $testRoot 'implementation-results'
    $implementation = Invoke-ParallelTest -Wrapper $canonicalWrapper -TaskFile $implementationTaskFile -ResultsDir $implementationResults
    Assert-Equal 0 $implementation.ExitCode ('Implementation batch should derive workspace-write automatically: ' + ($implementation.Output -join [Environment]::NewLine))

    $failureTasks = @(
        [ordered]@{ name='ok'; prompt=(@{name='ok';exitCode=0} | ConvertTo-Json -Compress); agent='agy' },
        [ordered]@{ name='bad'; prompt=(@{name='bad';exitCode=23;stderr='expected failure'} | ConvertTo-Json -Compress); agent='codex' }
    )
    $failureTaskFile = Join-Path $testRoot 'failure-tasks.json'
    [IO.File]::WriteAllText($failureTaskFile, ($failureTasks | ConvertTo-Json -Depth 5), $utf8NoBom)
    $failureResults = Join-Path $testRoot 'failure-results'
    $failure = Invoke-ParallelTest -Wrapper $canonicalWrapper -TaskFile $failureTaskFile -ResultsDir $failureResults
    Assert-Equal 1 $failure.ExitCode 'A mixed batch must return aggregate exit 1.'
    $failureSummary = [IO.File]::ReadAllText((Join-Path $failureResults 'summary.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Equal 1 $failureSummary.succeeded 'Mixed batch succeeded count is wrong.'
    Assert-Equal 1 $failureSummary.failed 'Mixed batch failed count is wrong.'
    Assert-Equal 23 $failureSummary.tasks[1].exitCode 'Per-task backend exit code was not preserved.'

    $timeoutTasks = @([ordered]@{ name='slow'; prompt=(@{name='slow';sleepMs=3000} | ConvertTo-Json -Compress); agent='agy' })
    $timeoutTaskFile = Join-Path $testRoot 'timeout-tasks.json'
    [IO.File]::WriteAllText($timeoutTaskFile, ($timeoutTasks | ConvertTo-Json -Depth 5), $utf8NoBom)
    $timeoutResults = Join-Path $testRoot 'timeout-results'
    $timeout = Invoke-ParallelTest -Wrapper $canonicalWrapper -TaskFile $timeoutTaskFile -ResultsDir $timeoutResults -TaskTimeoutSec 1
    Assert-Equal 124 $timeout.ExitCode ('A task-level timeout must return aggregate exit 124. Output: ' + ($timeout.Output -join [Environment]::NewLine))
    $timeoutSummary = [IO.File]::ReadAllText((Join-Path $timeoutResults 'summary.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Equal 'timed_out' $timeoutSummary.tasks[0].status 'Timeout status was not recorded.'
    Assert-True (([IO.File]::ReadAllText($timeoutSummary.tasks[0].stderrFile, [Text.Encoding]::UTF8)).Contains('process tree was terminated')) 'Timeout evidence was not preserved.'

    $scopeTasks = @(
        [ordered]@{ name='writer-one'; prompt='one'; agent='codex'; sandbox='workspace-write'; writeScope=@('src') },
        [ordered]@{ name='writer-two'; prompt='two'; agent='agy'; sandbox='workspace-write'; writeScope=@('src\api') }
    )
    $scopeTaskFile = Join-Path $testRoot 'scope-tasks.json'
    [IO.File]::WriteAllText($scopeTaskFile, ($scopeTasks | ConvertTo-Json -Depth 5), $utf8NoBom)
    $scopeResults = Join-Path $testRoot 'scope-results'
    $scope = Invoke-ParallelTest -Wrapper $canonicalWrapper -TaskFile $scopeTaskFile -ResultsDir $scopeResults
    Assert-True ($scope.ExitCode -ne 0) 'Overlapping parallel write scopes must be rejected.'
    Assert-True (($scope.Output -join [Environment]::NewLine).Contains('write scopes overlap')) 'Overlap rejection should explain the conflicting scopes.'

    Remove-Item -LiteralPath (Join-Path $barrierDir 'alpha.started'), (Join-Path $barrierDir 'beta.started') -Force
    $forwardedResults = Join-Path $testRoot 'forwarded-results'
    $forwarded = Invoke-ParallelTest -Wrapper $compatibilityWrapper -TaskFile $parallelTaskFile -ResultsDir $forwardedResults
    Assert-Equal 0 $forwarded.ExitCode ('Root parallel forwarder failed: ' + ($forwarded.Output -join [Environment]::NewLine))

    'parallel.Tests.ps1: all tests passed.'
}
finally {
    Remove-Item Env:FAKE_PARALLEL_BARRIER_DIR -ErrorAction SilentlyContinue
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
