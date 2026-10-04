$ErrorActionPreference = 'Stop'
$script:assertionsPassed = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
    $script:assertionsPassed++
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    $script:assertionsPassed++
}

function Invoke-ResolverFromScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string]$RequestedPath
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) {
        throw "Could not parse resolver source: $ScriptPath"
    }
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Resolve-CodexExecutable'
    }, $true)
    if (-not $definition) { throw "Resolve-CodexExecutable was not found: $ScriptPath" }

    $runner = [scriptblock]::Create("& { $($definition.Extent.Text); Resolve-CodexExecutable `$args[0] }")
    return & $runner $RequestedPath
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\codex.ps1'
$statusScript = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\status.ps1'
$fakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex.ps1'
$fakeSandboxFailure = Join-Path $PSScriptRoot 'fixtures\fake-codex-sandbox-failure.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-delegation-tools-{0}" -f [Guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
$savedDelegationDepth = $env:AGENT_DELEGATION_DEPTH
Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue
try {
    $resolverProfile = Join-Path $testRoot 'profile'
    $resolverCodexHome = Join-Path $testRoot 'codex-home'
    $resolverLocalAppData = Join-Path $testRoot 'local-app-data'
    $profileSandboxCodex = Join-Path $resolverProfile '.codex\.sandbox-bin\codex.exe'
    $homeSandboxCodex = Join-Path $resolverCodexHome '.sandbox-bin\codex.exe'
    $desktopBundle = Join-Path $resolverLocalAppData 'OpenAI\Codex\bin\bundle'
    $desktopCodex = Join-Path $desktopBundle 'codex.exe'
    $desktopCodeModeHost = Join-Path $desktopBundle 'codex-code-mode-host.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $profileSandboxCodex), (Split-Path -Parent $homeSandboxCodex), $desktopBundle | Out-Null
    New-Item -ItemType File -Path $profileSandboxCodex, $homeSandboxCodex | Out-Null

    $savedUserProfile = $env:USERPROFILE
    $savedCodexHome = $env:CODEX_HOME
    $savedLocalAppData = $env:LOCALAPPDATA
    try {
        $env:USERPROFILE = $resolverProfile
        $env:CODEX_HOME = $resolverCodexHome
        $env:LOCALAPPDATA = $resolverLocalAppData
        Assert-Equal $homeSandboxCodex (Invoke-ResolverFromScript -ScriptPath $wrapper) 'The worker should prefer the CODEX_HOME sandbox executable.'
        Assert-Equal $homeSandboxCodex (Invoke-ResolverFromScript -ScriptPath $statusScript) 'The status helper should prefer the CODEX_HOME sandbox executable.'

        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
        New-Item -ItemType File -Path $desktopCodex, $desktopCodeModeHost | Out-Null
        Assert-Equal $desktopCodex (Invoke-ResolverFromScript -ScriptPath $wrapper) 'The worker should prefer a complete Desktop Codex bundle.'
        Assert-Equal $desktopCodex (Invoke-ResolverFromScript -ScriptPath $statusScript) 'The status helper should prefer a complete Desktop Codex bundle.'

        Remove-Item -LiteralPath $desktopCodeModeHost -Force
        Assert-Equal $profileSandboxCodex (Invoke-ResolverFromScript -ScriptPath $wrapper) 'The worker should fall back to the USERPROFILE sandbox executable.'
        Assert-Equal $profileSandboxCodex (Invoke-ResolverFromScript -ScriptPath $statusScript) 'The status helper should fall back to the USERPROFILE sandbox executable.'
    }
    finally {
        $env:USERPROFILE = $savedUserProfile
        if ($null -eq $savedCodexHome) {
            Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
        }
        else {
            $env:CODEX_HOME = $savedCodexHome
        }
        $env:LOCALAPPDATA = $savedLocalAppData
    }

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
    Assert-Equal '--approve-for-me' $arguments[1] 'The workspace-write automatic approval flag is missing.'
    Assert-True (-not ($arguments -contains '--sandbox')) 'Current Codex CLI rejects --approve-for-me combined with --sandbox.'
    $cdIndex = [Array]::IndexOf($arguments, '--cd')
    Assert-True ($cdIndex -ge 0) 'Working-directory flag is missing.'
    $firstAlias = $arguments[$cdIndex + 1]
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
    if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -match '(?i)\\CodexSandbox(?:Offline)?$') {
        Assert-True (($authenticationOutput -join [Environment]::NewLine).Contains('approved host-execution')) 'A Codex sandbox identity must receive safe host-execution guidance.'
    }
    Assert-True (-not (Test-Path -LiteralPath $argsFile)) 'The delegated Codex task must not launch before login succeeds.'
    $env:FAKE_CODEX_LOGGED_IN = 'true'

    # Exercise each precise startup signature on both output streams.
    foreach ($entryPoint in @($wrapper)) {
        foreach ($signature in @('helper_unknown_error', 'setup refresh had errors', 'Failed to create unified exec process', 'WINDOWS SANDBOX FAILED')) {
            foreach ($stream in @('stdout', 'stderr')) {
                $env:FAKE_SANDBOX_FAILURE_TEXT = $signature
                $env:FAKE_SANDBOX_FAILURE_STREAM = $stream
                $previousErrorActionPreference = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                try {
                    $failureOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entryPoint `
                        -CodexPath $fakeSandboxFailure -WorkDir $firstWorkDir -NoAliasPath `
                        -Sandbox workspace-write -SkipGitCheck 'Detect a startup failure.' 2>&1)
                    $failureExitCode = $LASTEXITCODE
                }
                finally {
                    $ErrorActionPreference = $previousErrorActionPreference
                }
                Assert-Equal 79 $failureExitCode "A zero-exit startup failure on $stream must fail via $entryPoint."
                Assert-True (($failureOutput -join "`n").Contains($signature)) 'The startup failure transcript must be preserved.'
            }
        }
        # A run whose commands succeeded but printed a note quoting the signatures
        # (e.g. reading AI_HANDOFF.md) must stay a success.
        $env:FAKE_SANDBOX_FAILURE_TEXT = " succeeded in 120ms:`n- Earlier note: helper_unknown_error: setup refresh had errors`nFailed to create unified exec process: helper_unknown_error"
        $env:FAKE_SANDBOX_FAILURE_STREAM = 'stderr'
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $null = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entryPoint `
                -CodexPath $fakeSandboxFailure -WorkDir $firstWorkDir -NoAliasPath `
                -Sandbox workspace-write -SkipGitCheck 'Quote a startup failure.' 2>&1)
            $quotedExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        Assert-Equal 0 $quotedExitCode 'Signatures quoted in output after a successful command must not become an environment failure.'
        $env:FAKE_CODEX_OUTPUT = 'The ordinary task failed; sandbox permissions denied.'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entryPoint `
            -CodexPath $fakeCodex -WorkDir $firstWorkDir -NoAliasPath `
            -Sandbox workspace-write -SkipGitCheck 'Preserve an ordinary task result.'
        Assert-Equal 0 $LASTEXITCODE 'Generic task or sandbox wording must not become an environment failure.'
    }

    Remove-Item -LiteralPath $argsFile -Force
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
    "Assertions: $script:assertionsPassed passed, 0 failed."
}
finally {
    Remove-Item Env:FAKE_CODEX_ARGS_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_EXIT_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_OUTPUT -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_ERROR -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_SLEEP_MS -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_CODEX_LOGGED_IN -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_SANDBOX_FAILURE_TEXT -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_SANDBOX_FAILURE_STREAM -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue
    if ($null -ne $savedDelegationDepth) { $env:AGENT_DELEGATION_DEPTH = $savedDelegationDepth }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
