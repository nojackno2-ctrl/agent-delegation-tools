$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$compatibilityWrapper = Join-Path $repositoryRoot 'codex.ps1'
$wrapper = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\codex.ps1'
$fakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-delegation-tools-{0}" -f [Guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $aliasRoot = Join-Path $testRoot 'aliases'
    # Construct non-ASCII names at runtime so Windows PowerShell 5.1 can parse
    # this UTF-8-without-BOM test file consistently.
    $firstWorkDir = Join-Path $testRoot (([char]0x7532) + '\project')
    $secondWorkDir = Join-Path $testRoot (([char]0x4E59) + '\project')
    $additionalDir = Join-Path $testRoot (([char]0x5171) + ([char]0x4EAB) + '\fixtures')
    $argsFile = Join-Path $testRoot 'args.txt'
    $outFile = Join-Path $testRoot 'result.txt'
    New-Item -ItemType Directory -Path $firstWorkDir, $secondWorkDir, $additionalDir | Out-Null

    $env:FAKE_CODEX_ARGS_FILE = $argsFile
    $env:FAKE_CODEX_EXIT_CODE = '0'
    $env:FAKE_CODEX_OUTPUT = 'codex output'
    $env:FAKE_CODEX_LOGGED_IN = 'true'

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
        -CodexPath $fakeCodex `
        -WorkDir $firstWorkDir `
        -AliasRoot $aliasRoot `
        -Sandbox workspace-write `
        -AddDir $additionalDir `
        -Effort high `
        -OutFile $outFile `
        -Ephemeral `
        -ApproveForMe `
        -SkipGitCheck `
        'Inspect only; do not edit.'
    Assert-Equal 0 $LASTEXITCODE 'The wrapper should preserve a successful CLI exit code.'

    $arguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal 'exec' $arguments[0] 'The wrapper should invoke codex exec.'
    Assert-Equal '--sandbox' $arguments[1] 'Sandbox flag is missing.'
    Assert-Equal 'workspace-write' $arguments[2] 'Sandbox value was not forwarded.'
    Assert-Equal '--cd' $arguments[3] 'Working-directory flag is missing.'
    $firstAlias = $arguments[4]
    Assert-True ($firstAlias -notmatch '[^\x20-\x7E]') 'The primary alias should contain printable ASCII only.'
    Assert-True (Test-Path -LiteralPath $firstAlias -PathType Container) 'The primary alias should exist.'
    $addDirIndex = [Array]::IndexOf($arguments, '--add-dir')
    Assert-True ($addDirIndex -ge 0) 'The additional-directory flag is missing.'
    Assert-True ($arguments[$addDirIndex + 1] -notmatch '[^\x20-\x7E]') 'The additional-directory alias should contain printable ASCII only.'
    Assert-True ($arguments -contains '--ephemeral') 'The ephemeral flag is missing.'
    Assert-True ($arguments -contains '--approve-for-me') 'The approval-review flag is missing.'
    Assert-Equal 'model_reasoning_effort="high"' $arguments[[Array]::IndexOf($arguments, '-c') + 1] 'Reasoning effort was not encoded correctly.'
    Assert-Equal ([IO.Path]::GetFullPath($outFile)) $arguments[[Array]::IndexOf($arguments, '--output-last-message') + 1] 'OutFile should be absolute.'
    Assert-Equal 'Inspect only; do not edit.' $arguments[-1] 'The prompt should remain the final argument.'

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
        -CodexPath $fakeCodex `
        -WorkDir $secondWorkDir `
        -AliasRoot $aliasRoot `
        -Sandbox read-only `
        -SkipGitCheck `
        'Second workspace.'
    Assert-Equal 0 $LASTEXITCODE 'The second invocation should succeed.'
    $secondArguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    $secondAlias = $secondArguments[4]
    Assert-True ($firstAlias -ne $secondAlias) 'Equal leaf names must receive different hashed aliases.'
    Assert-True (Test-Path -LiteralPath $firstAlias -PathType Container) 'The first alias must not be removed or repointed.'

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
            -CodexPath $fakeCodex `
            -WorkDir $firstWorkDir `
            -AliasRoot $aliasRoot `
            -Sandbox read-only `
            -ApproveForMe `
            -SkipGitCheck `
            'This unsafe combination must fail.' 2>$null
        $unsafeCombinationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-True ($unsafeCombinationExitCode -ne 0) 'ApproveForMe must not weaken a read-only invocation.'

    $env:FAKE_CODEX_EXIT_CODE = '23'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
        -CodexPath $fakeCodex `
        -WorkDir $firstWorkDir `
        -AliasRoot $aliasRoot `
        -Sandbox read-only `
        -SkipGitCheck `
        'Return the fake failure.'
    Assert-Equal 23 $LASTEXITCODE 'The wrapper should preserve a failing CLI exit code.'

    $env:FAKE_CODEX_EXIT_CODE = '0'
    $env:FAKE_CODEX_SLEEP_MS = '3000'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
        -CodexPath $fakeCodex `
        -WorkDir $firstWorkDir `
        -NoAliasPath `
        -Sandbox read-only `
        -TimeoutSec 1 `
        -SkipGitCheck `
        'Bound the fake worker.'
    Assert-Equal 124 $LASTEXITCODE 'The wrapper should return 124 after its wall-clock timeout.'
    Remove-Item Env:FAKE_CODEX_SLEEP_MS

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $compatibilityWrapper `
        -CodexPath $fakeCodex `
        -WorkDir $firstWorkDir `
        -NoAliasPath `
        -Sandbox read-only `
        -SkipGitCheck `
        'Compatibility entry point.'
    Assert-Equal 0 $LASTEXITCODE 'The root compatibility wrapper should forward new parameters.'
    $compatibilityArguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal $firstWorkDir $compatibilityArguments[4] 'NoAliasPath should preserve the real working directory.'
    Assert-Equal 'Compatibility entry point.' $compatibilityArguments[-1] 'The root wrapper should preserve the prompt.'

    $driveRoot = [IO.Path]::GetPathRoot($testRoot)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
        -CodexPath $fakeCodex `
        -WorkDir $driveRoot `
        -NoAliasPath `
        -Sandbox read-only `
        -SkipGitCheck `
        'Preserve the drive root.'
    Assert-Equal 0 $LASTEXITCODE 'A drive-root working directory should be accepted.'
    $driveRootArguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal $driveRoot $driveRootArguments[4] 'Drive-root normalization must preserve the trailing separator.'

    Remove-Item -LiteralPath $argsFile -Force
    $env:FAKE_CODEX_LOGGED_IN = 'false'
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $authenticationOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
            -CodexPath $fakeCodex `
            -WorkDir $firstWorkDir `
            -NoAliasPath `
            -Sandbox workspace-write `
            -SkipGitCheck `
            'Do not launch while logged out.' 2>&1)
        $authenticationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-Equal 78 $authenticationExitCode 'A logged-out Codex CLI must return the login-required exit code.'
    Assert-True (($authenticationOutput -join [Environment]::NewLine).Contains('codex login')) 'A logged-out Codex CLI must tell the user how to sign in.'
    Assert-True (-not (Test-Path -LiteralPath $argsFile)) 'The delegated Codex task must not launch before login succeeds.'
    $env:FAKE_CODEX_LOGGED_IN = 'true'

    $env:AGENT_DELEGATION_DEPTH = '1'
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper `
            -CodexPath $fakeCodex `
            -WorkDir $firstWorkDir `
            -NoAliasPath `
            -Sandbox read-only `
            -SkipGitCheck `
            'Recursive invocation must fail.' 2>$null
        $recursiveExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue
    }
    Assert-True ($recursiveExitCode -ne 0) 'Codex recursion guard should reject nested delegation.'
    Assert-True (-not (Test-Path -LiteralPath $argsFile)) 'Recursion rejection must happen before Codex launches.'

    'codex-wrapper.Tests.ps1: all tests passed.'
}
finally {
    Remove-Item Env:FAKE_CODEX_ARGS_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_EXIT_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_OUTPUT -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_ERROR -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_SLEEP_MS -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_LOGGED_IN -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
