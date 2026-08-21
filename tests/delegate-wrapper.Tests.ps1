$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-EncodedChild {
    param([Parameter(Mandatory = $true)][string]$Command)
    $harness = Join-Path ([IO.Path]::GetTempPath()) ("delegate-test-harness-{0}.ps1" -f [Guid]::NewGuid().ToString('N'))
    $harnessCommand = $Command + [Environment]::NewLine + 'exit $LASTEXITCODE'
    [IO.File]::WriteAllText($harness, $harnessCommand, (New-Object Text.UTF8Encoding($false)))
    try {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $childOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $harness 2>&1)
            $childExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        return [pscustomobject]@{ ExitCode = $childExitCode; Output = $childOutput }
    }
    finally {
        Remove-Item -LiteralPath $harness -Force -ErrorAction SilentlyContinue
    }
}

function Read-RecordedArguments {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)
}

function Clear-BackendEvidence {
    param([string[]]$Paths)
    foreach ($path in $Paths) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\delegate.ps1'
$compatibilityWrapper = Join-Path $repositoryRoot 'delegate.ps1'
$fakeAgy = Join-Path $PSScriptRoot 'fixtures\fake-agy.ps1'
$fakeClaude = Join-Path $PSScriptRoot 'fixtures\fake-claude.ps1'
$fakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("delegate-wrapper-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $workDir = Join-Path $testRoot 'workspace'
    $addDir = Join-Path $testRoot 'additional'
    New-Item -ItemType Directory -Path $workDir, $addDir | Out-Null
    $agyArgsFile = Join-Path $testRoot 'agy-args.json'
    $claudeArgsFile = Join-Path $testRoot 'claude-args.json'
    $claudePromptFile = Join-Path $testRoot 'claude-prompt.txt'
    $codexArgsFile = Join-Path $testRoot 'codex-args.txt'
    $outFile = Join-Path $testRoot 'dispatcher-output.txt'
    $evidenceFiles = @($agyArgsFile, $claudeArgsFile, $claudePromptFile, $codexArgsFile)
    $prompt = ([char]0x59D4) + ([char]0x6D3E) + ' "quoted" task.'

    $env:TEST_WRAPPER = $wrapper
    $env:TEST_AGY = $fakeAgy
    $env:TEST_CLAUDE = $fakeClaude
    $env:TEST_CODEX = $fakeCodex
    $env:TEST_WORKDIR = $workDir
    $env:TEST_ADDDIR = $addDir
    $env:TEST_OUTFILE = $outFile
    $env:TEST_PROMPT = $prompt
    $env:FAKE_AGY_ARGS_FILE = $agyArgsFile
    $env:FAKE_AGY_EXIT_CODE = '0'
    $env:FAKE_AGY_OUTPUT = 'analysis result'
    $env:FAKE_CLAUDE_ARGS_FILE = $claudeArgsFile
    $env:FAKE_CLAUDE_PROMPT_FILE = $claudePromptFile
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = 'review result'
    $env:FAKE_CLAUDE_LOGGED_IN = 'true'
    $env:FAKE_CODEX_ARGS_FILE = $codexArgsFile
    $env:FAKE_CODEX_EXIT_CODE = '0'
    $env:FAKE_CODEX_LOGGED_IN = 'true'

    Clear-BackendEvidence $evidenceFiles
    $analysis = Invoke-EncodedChild '& $env:TEST_WRAPPER -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -AddDir $env:TEST_ADDDIR -OutFile $env:TEST_OUTFILE -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $analysis.ExitCode ('Default analysis dispatch failed: ' + ($analysis.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $agyArgsFile -PathType Leaf) 'Default analysis should route to AGY.'
    Assert-True (-not (Test-Path -LiteralPath $claudeArgsFile)) 'Analysis dispatch must not also launch Claude.'
    Assert-True (-not (Test-Path -LiteralPath $codexArgsFile)) 'Analysis dispatch must not also launch Codex.'
    $analysisArguments = Read-RecordedArguments $agyArgsFile
    Assert-Equal 'plan' $analysisArguments[[Array]::IndexOf($analysisArguments, '--mode') + 1] 'Default dispatcher analysis must be read-only.'
    Assert-Equal $addDir $analysisArguments[[Array]::IndexOf($analysisArguments, '--add-dir') + 1] 'Dispatcher did not forward AGY AddDir.'
    Assert-Equal $prompt $analysisArguments[1] 'Dispatcher changed the AGY prompt.'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_CLAUDE_OUTPUT = 'review result'
    $review = Invoke-EncodedChild '& $env:TEST_WRAPPER -TaskType review -ClaudePath $env:TEST_CLAUDE -WorkDir $env:TEST_WORKDIR -OutFile $env:TEST_OUTFILE -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $review.ExitCode ('Review dispatch failed: ' + ($review.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $claudeArgsFile -PathType Leaf) 'Review should route to Claude.'
    Assert-True (-not (Test-Path -LiteralPath $agyArgsFile)) 'Review dispatch must not also launch AGY.'
    Assert-True (-not (Test-Path -LiteralPath $codexArgsFile)) 'Review dispatch must not also launch Codex.'
    $reviewArguments = Read-RecordedArguments $claudeArgsFile
    Assert-Equal 'plan' $reviewArguments[[Array]::IndexOf($reviewArguments, '--permission-mode') + 1] 'Review dispatch must be read-only.'
    Assert-Equal $prompt ([IO.File]::ReadAllText($claudePromptFile, [Text.Encoding]::UTF8)) 'Dispatcher changed the Claude stdin prompt.'

    Clear-BackendEvidence $evidenceFiles
    $implementation = Invoke-EncodedChild '& $env:TEST_WRAPPER -TaskType implementation -Sandbox workspace-write -CodexModel codex-child-model -CodexEffort xhigh -CodexPath $env:TEST_CODEX -WorkDir $env:TEST_WORKDIR -SkipGitCheck -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $implementation.ExitCode ('Implementation dispatch failed: ' + ($implementation.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $codexArgsFile -PathType Leaf) 'Implementation should route to Codex.'
    Assert-True (-not (Test-Path -LiteralPath $agyArgsFile)) 'Implementation dispatch must not also launch AGY.'
    Assert-True (-not (Test-Path -LiteralPath $claudeArgsFile)) 'Implementation dispatch must not also launch Claude.'
    $codexArguments = [IO.File]::ReadAllLines($codexArgsFile, [Text.Encoding]::UTF8)
    Assert-Equal 'workspace-write' $codexArguments[2] 'Implementation dispatch must default to workspace-write.'
    Assert-Equal 'codex-child-model' $codexArguments[[Array]::IndexOf($codexArguments, '--model') + 1] 'Parent-selected Codex child model was not forwarded.'
    Assert-True ($codexArguments -contains 'model_reasoning_effort="xhigh"') 'Parent-selected Codex child effort was not forwarded.'
    Assert-Equal $prompt $codexArguments[-1] 'Dispatcher changed the Codex prompt.'

    Clear-BackendEvidence $evidenceFiles
    $userConfigured = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent auto -TaskType implementation -Sandbox workspace-write -Model user-selected-model -Effort ultra -CodexPath $env:TEST_CODEX -WorkDir $env:TEST_WORKDIR -SkipGitCheck -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $userConfigured.ExitCode ('User-configured automatic dispatch failed: ' + ($userConfigured.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $codexArgsFile -PathType Leaf) 'Automatic implementation routing should select Codex for user-configured child settings.'
    $userConfiguredArguments = [IO.File]::ReadAllLines($codexArgsFile, [Text.Encoding]::UTF8)
    Assert-Equal 'user-selected-model' $userConfiguredArguments[[Array]::IndexOf($userConfiguredArguments, '--model') + 1] 'The explicit primary-child model was not preserved during automatic routing.'
    Assert-True ($userConfiguredArguments -contains 'model_reasoning_effort="ultra"') 'The explicit primary-child effort was not preserved during automatic routing.'

    Clear-BackendEvidence $evidenceFiles
    $scaffolding = Invoke-EncodedChild '& $env:TEST_WRAPPER -TaskType scaffolding -Sandbox workspace-write -AgySkipPermissions -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $scaffolding.ExitCode ('Scaffolding dispatch failed: ' + ($scaffolding.Output -join [Environment]::NewLine))
    $scaffoldingArguments = Read-RecordedArguments $agyArgsFile
    Assert-Equal 'accept-edits' $scaffoldingArguments[[Array]::IndexOf($scaffoldingArguments, '--mode') + 1] 'Explicit scaffolding write mode was not forwarded to AGY.'
    Assert-True ($scaffoldingArguments -contains '--dangerously-skip-permissions') 'Explicit AGY headless write authorization was not forwarded.'

    Clear-BackendEvidence $evidenceFiles
    $unsafeAgyApproval = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -AgySkipPermissions -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-True ($unsafeAgyApproval.ExitCode -ne 0) 'AGY permission bypass must be rejected for a read-only dispatch.'
    Assert-True (-not (Test-Path -LiteralPath $agyArgsFile)) 'Unsafe AGY permission validation must happen before launch.'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_AGY_SLEEP_MS = '3000'
    $timeout = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -TimeoutSec 1 -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -OutFile $env:TEST_OUTFILE -Prompt $env:TEST_PROMPT'
    Assert-Equal 124 $timeout.ExitCode 'The dispatcher must return 124 after a backend wall-clock timeout.'
    Assert-True (([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)).Contains('timed out after 1 seconds')) 'Timeout evidence should be preserved in OutFile.'
    Remove-Item Env:FAKE_AGY_SLEEP_MS

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_AGY_EXIT_CODE = '42'
    $failure = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -FallbackAgent claude -AgyPath $env:TEST_AGY -ClaudePath $env:TEST_CLAUDE -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-Equal 42 $failure.ExitCode 'Dispatcher must propagate the selected backend exit code.'
    Assert-True (-not (Test-Path -LiteralPath $claudeArgsFile)) 'A non-quota backend failure must not launch a fallback CLI.'
    $env:FAKE_AGY_EXIT_CODE = '0'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_CODEX_LOGGED_IN = 'false'
    $loggedOut = Invoke-EncodedChild '& $env:TEST_WRAPPER -TaskType implementation -Sandbox workspace-write -FallbackAgent claude -CodexPath $env:TEST_CODEX -ClaudePath $env:TEST_CLAUDE -WorkDir $env:TEST_WORKDIR -SkipGitCheck -Prompt $env:TEST_PROMPT'
    Assert-Equal 78 $loggedOut.ExitCode 'Dispatcher must preserve the login-required exit code.'
    Assert-True (($loggedOut.Output -join [Environment]::NewLine).Contains('codex login')) 'Dispatcher must surface the Codex login instruction.'
    Assert-True (-not (Test-Path -LiteralPath $codexArgsFile)) 'A logged-out Codex child task must not launch.'
    Assert-True (-not (Test-Path -LiteralPath $claudeArgsFile)) 'Authentication failure must stop instead of silently switching providers.'
    $env:FAKE_CODEX_LOGGED_IN = 'true'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_AGY_EXIT_CODE = '29'
    $env:FAKE_AGY_OUTPUT = 'Error: usage limit reached for this account.'
    $env:FAKE_CLAUDE_OUTPUT = '{"is_error":false,"result":"fallback result"}'
    $fallback = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -FallbackAgent claude -AgyModel agy-child-model -AgyEffort high -ClaudeModel claude-child-model -ClaudeEffort xhigh -AgyPath $env:TEST_AGY -ClaudePath $env:TEST_CLAUDE -WorkDir $env:TEST_WORKDIR -OutFile $env:TEST_OUTFILE -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $fallback.ExitCode ('Quota fallback failed: ' + ($fallback.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $agyArgsFile -PathType Leaf) 'Quota fallback did not launch the primary AGY child.'
    Assert-True (Test-Path -LiteralPath $claudeArgsFile -PathType Leaf) 'Quota fallback did not launch the Claude child.'
    $fallbackAgyArguments = Read-RecordedArguments $agyArgsFile
    Assert-Equal 'agy-child-model' $fallbackAgyArguments[[Array]::IndexOf($fallbackAgyArguments, '--model') + 1] 'Parent-selected AGY child model was not forwarded.'
    Assert-Equal 'high' $fallbackAgyArguments[[Array]::IndexOf($fallbackAgyArguments, '--effort') + 1] 'Parent-selected AGY child effort was not forwarded.'
    $fallbackClaudeArguments = Read-RecordedArguments $claudeArgsFile
    Assert-Equal 'claude-child-model' $fallbackClaudeArguments[[Array]::IndexOf($fallbackClaudeArguments, '--model') + 1] 'Parent-selected Claude child model was not forwarded.'
    Assert-Equal 'xhigh' $fallbackClaudeArguments[[Array]::IndexOf($fallbackClaudeArguments, '--effort') + 1] 'Parent-selected Claude child effort was not forwarded.'
    $fallbackPrompt = [IO.File]::ReadAllText($claudePromptFile, [Text.Encoding]::UTF8)
    Assert-True ($fallbackPrompt.Contains($prompt)) 'Cross-CLI handoff did not preserve the original task.'
    Assert-True ($fallbackPrompt.Contains('previous agy child')) 'Cross-CLI handoff did not identify the exhausted prior child.'
    Assert-True ($fallbackPrompt.Contains('usage limit reached')) 'Cross-CLI handoff did not preserve usable prior output.'
    Assert-Equal 'fallback result' ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) 'Dispatcher OutFile did not receive the successful fallback result.'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_AGY_EXIT_CODE = '29'
    $env:FAKE_AGY_OUTPUT = 'HTTP 429: quota exhausted.'
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = '{"is_error":true,"result":"You have hit your usage limit."}'
    $allExhausted = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -FallbackAgent claude -AgyPath $env:TEST_AGY -ClaudePath $env:TEST_CLAUDE -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-Equal 75 $allExhausted.ExitCode 'An exhausted fallback chain must return the documented quota exit code.'
    Assert-True (Test-Path -LiteralPath $claudeArgsFile -PathType Leaf) 'The exhausted chain did not try its final candidate.'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = '{"is_error":true,"result":"You have hit your usage limit."}'
    $env:FAKE_CODEX_EXIT_CODE = '0'
    $claudeToCodex = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent claude -FallbackAgent codex -ClaudeModel claude-primary -ClaudeEffort high -CodexModel codex-fallback -CodexEffort max -ClaudePath $env:TEST_CLAUDE -CodexPath $env:TEST_CODEX -WorkDir $env:TEST_WORKDIR -SkipGitCheck -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $claudeToCodex.ExitCode ('Claude-to-Codex quota fallback failed: ' + ($claudeToCodex.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $codexArgsFile -PathType Leaf) 'Structured Claude quota failure did not launch the Codex fallback child.'
    $fallbackCodexArguments = [IO.File]::ReadAllLines($codexArgsFile, [Text.Encoding]::UTF8)
    Assert-Equal 'codex-fallback' $fallbackCodexArguments[[Array]::IndexOf($fallbackCodexArguments, '--model') + 1] 'Parent-selected Codex fallback model was not forwarded.'
    Assert-True ($fallbackCodexArguments -contains 'model_reasoning_effort="max"') 'Parent-selected Codex fallback effort was not forwarded.'
    Assert-True (([IO.File]::ReadAllText($codexArgsFile, [Text.Encoding]::UTF8)).Contains($prompt)) 'Claude-to-Codex continuation did not preserve the original task.'

    $env:FAKE_AGY_EXIT_CODE = '0'
    $env:FAKE_AGY_OUTPUT = 'analysis result'
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = 'review result'

    Clear-BackendEvidence $evidenceFiles
    $env:TEST_WRAPPER = $compatibilityWrapper
    $forwarded = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $forwarded.ExitCode ('Root dispatcher forwarder failed: ' + ($forwarded.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $agyArgsFile -PathType Leaf) 'Root dispatcher did not reach the selected backend.'

    Clear-BackendEvidence $evidenceFiles
    $env:FAKE_AGY_EXIT_CODE = '29'
    $env:FAKE_AGY_OUTPUT = 'AGY quota exhausted after partial progress.'
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = '{"is_error":true,"result":"Claude usage limit reached."}'
    $env:FAKE_CODEX_EXIT_CODE = '0'
    $threeBackendFallback = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -FallbackAgent ''claude,codex'' -AgyPath $env:TEST_AGY -ClaudePath $env:TEST_CLAUDE -CodexPath $env:TEST_CODEX -WorkDir $env:TEST_WORKDIR -SkipGitCheck -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $threeBackendFallback.ExitCode ('Root three-backend fallback failed: ' + ($threeBackendFallback.Output -join [Environment]::NewLine))
    Assert-True (Test-Path -LiteralPath $agyArgsFile -PathType Leaf) 'Three-backend chain did not launch AGY first.'
    Assert-True (Test-Path -LiteralPath $claudeArgsFile -PathType Leaf) 'Three-backend chain did not launch Claude second.'
    Assert-True (Test-Path -LiteralPath $codexArgsFile -PathType Leaf) 'Three-backend chain did not launch Codex third.'
    $threeBackendCodexRecord = [IO.File]::ReadAllText($codexArgsFile, [Text.Encoding]::UTF8)
    Assert-True ($threeBackendCodexRecord.Contains('AGY quota exhausted after partial progress.')) 'Third child did not retain first-child progress notes.'
    Assert-True ($threeBackendCodexRecord.Contains('Claude usage limit reached.')) 'Third child did not receive second-child quota evidence.'

    Clear-BackendEvidence $evidenceFiles
    $invalidFallback = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -FallbackAgent invalid -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-True ($invalidFallback.ExitCode -ne 0) 'Root dispatcher must return nonzero for an invalid fallback value.'
    Assert-True (-not (Test-Path -LiteralPath $agyArgsFile)) 'Invalid fallback validation must happen before a backend launches.'

    $env:FAKE_AGY_EXIT_CODE = '0'
    $env:FAKE_AGY_OUTPUT = 'analysis result'
    $env:FAKE_CLAUDE_OUTPUT = 'review result'

    Clear-BackendEvidence $evidenceFiles
    $env:AGENT_DELEGATION_DEPTH = '1'
    $env:TEST_WRAPPER = $wrapper
    $recursive = Invoke-EncodedChild '& $env:TEST_WRAPPER -Agent agy -AgyPath $env:TEST_AGY -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-True ($recursive.ExitCode -ne 0) 'Dispatcher recursion guard should reject nested delegation.'
    Assert-True (-not (Test-Path -LiteralPath $agyArgsFile)) 'Recursion rejection must happen before a backend launches.'
    Remove-Item Env:AGENT_DELEGATION_DEPTH

    'delegate-wrapper.Tests.ps1: all tests passed.'
}
finally {
    foreach ($name in @('TEST_WRAPPER','TEST_AGY','TEST_CLAUDE','TEST_CODEX','TEST_WORKDIR','TEST_ADDDIR','TEST_OUTFILE','TEST_PROMPT','FAKE_AGY_ARGS_FILE','FAKE_AGY_EXIT_CODE','FAKE_AGY_OUTPUT','FAKE_AGY_SLEEP_MS','FAKE_CLAUDE_ARGS_FILE','FAKE_CLAUDE_PROMPT_FILE','FAKE_CLAUDE_CWD_FILE','FAKE_CLAUDE_DEPTH_FILE','FAKE_CLAUDE_EXIT_CODE','FAKE_CLAUDE_OUTPUT','FAKE_CLAUDE_ERROR','FAKE_CLAUDE_SLEEP_MS','FAKE_CLAUDE_LOGGED_IN','FAKE_CODEX_ARGS_FILE','FAKE_CODEX_EXIT_CODE','FAKE_CODEX_OUTPUT','FAKE_CODEX_ERROR','FAKE_CODEX_SLEEP_MS','FAKE_CODEX_LOGGED_IN','AGENT_DELEGATION_DEPTH')) {
        Remove-Item -LiteralPath ("Env:$name") -ErrorAction SilentlyContinue
    }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
