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
    $harness = Join-Path ([IO.Path]::GetTempPath()) ("claude-test-harness-{0}.ps1" -f [Guid]::NewGuid().ToString('N'))
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

function Assert-NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Message)
    $bytes = [IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Assert-True (-not $hasBom) $Message
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\claude.ps1'
$compatibilityWrapper = Join-Path $repositoryRoot 'claude.ps1'
$fakeClaude = Join-Path $PSScriptRoot 'fixtures\fake-claude.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("claude-wrapper-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $workDir = Join-Path $testRoot 'workspace'
    $addDir = Join-Path $testRoot 'additional'
    New-Item -ItemType Directory -Path $workDir, $addDir | Out-Null
    $argsFile = Join-Path $testRoot 'args.json'
    $promptFile = Join-Path $testRoot 'prompt.txt'
    $cwdFile = Join-Path $testRoot 'cwd.txt'
    $depthFile = Join-Path $testRoot 'depth.txt'
    $outFile = Join-Path $testRoot 'claude-output.txt'
    $rawFile = Join-Path $testRoot 'claude-raw.json'
    $prompt = ([char]0x6AA2) + ([char]0x67E5) + ' "double quotes", ''single quotes'', spaces, and ' + ([char]0x8DEF) + ([char]0x5F91) + ".`nSecond line."
    $expectedMessage = ([char]0x56DE) + ([char]0x8986) + ' "preserved"'
    $jsonEnvelope = ConvertTo-Json -Compress -InputObject ([ordered]@{ result = $expectedMessage; session_id = 'fake-session' })

    $env:TEST_WRAPPER = $wrapper
    $env:TEST_CLI = $fakeClaude
    $env:TEST_WORKDIR = $workDir
    $env:TEST_ADDDIR = $addDir
    $env:TEST_OUTFILE = $outFile
    $env:TEST_RAWFILE = $rawFile
    $env:TEST_PROMPT = $prompt
    $env:FAKE_CLAUDE_ARGS_FILE = $argsFile
    $env:FAKE_CLAUDE_PROMPT_FILE = $promptFile
    $env:FAKE_CLAUDE_CWD_FILE = $cwdFile
    $env:FAKE_CLAUDE_DEPTH_FILE = $depthFile
    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = $jsonEnvelope
    $env:FAKE_CLAUDE_LOGGED_IN = 'true'

    $command = '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -AddDir $env:TEST_ADDDIR -OutFile $env:TEST_OUTFILE -RawFile $env:TEST_RAWFILE -Mode workspace-write -Model fake-model -Effort high -AllowedTools Read,Grep -AppendSystemPrompt ''Keep "quotes".'' -TimeoutSec 10 -Prompt $env:TEST_PROMPT'
    $result = Invoke-EncodedChild $command
    Assert-Equal 0 $result.ExitCode ('Claude wrapper failed: ' + ($result.Output -join [Environment]::NewLine))

    $arguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-True ($arguments -contains '-p') 'Claude print flag is missing.'
    Assert-Equal 'acceptEdits' $arguments[[Array]::IndexOf($arguments, '--permission-mode') + 1] 'Explicit workspace-write was not mapped to acceptEdits.'
    Assert-True ($arguments -contains '--safe-mode') 'Claude should default to isolated safe mode.'
    Assert-True ($arguments -contains '--no-session-persistence') 'One-shot Claude delegation should not persist a session by default.'
    Assert-Equal 'false' $arguments[[Array]::IndexOf($arguments, '--prompt-suggestions') + 1] 'Claude prompt suggestions should be disabled by default.'
    Assert-Equal $addDir $arguments[[Array]::IndexOf($arguments, '--add-dir') + 1] 'Claude additional directory was not absolute or was changed.'
    Assert-Equal $prompt ([IO.File]::ReadAllText($promptFile, [Text.Encoding]::UTF8)) 'Claude prompt did not survive UTF-8 stdin exactly.'
    Assert-Equal $workDir ([IO.File]::ReadAllText($cwdFile, [Text.Encoding]::UTF8)) 'Claude working directory was not applied.'
    Assert-Equal '1' ([IO.File]::ReadAllText($depthFile, [Text.Encoding]::UTF8)) 'Claude child should receive recursion depth 1.'
    Assert-Equal $expectedMessage ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) 'Claude final-message file content changed.'
    Assert-Equal $jsonEnvelope ([IO.File]::ReadAllText($rawFile, [Text.Encoding]::UTF8)) 'Claude raw output file content changed.'
    Assert-NoBom $outFile 'Claude final-message output must be UTF-8 without a BOM.'
    Assert-NoBom $rawFile 'Claude raw output must be UTF-8 without a BOM.'

    $env:FAKE_CLAUDE_OUTPUT = 'plain failure output'
    $env:FAKE_CLAUDE_EXIT_CODE = '27'
    $failure = Invoke-EncodedChild '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -OutputFormat text -TimeoutSec 10 -Prompt $env:TEST_PROMPT'
    Assert-Equal 27 $failure.ExitCode 'Claude wrapper must propagate CLI failures.'

    Remove-Item -LiteralPath $argsFile, $promptFile -Force
    $env:FAKE_CLAUDE_LOGGED_IN = 'false'
    $authentication = Invoke-EncodedChild '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -OutFile $env:TEST_OUTFILE -TimeoutSec 10 -Prompt $env:TEST_PROMPT'
    Assert-Equal 78 $authentication.ExitCode 'A logged-out Claude CLI must return the login-required exit code.'
    Assert-True (($authentication.Output -join [Environment]::NewLine).Contains('claude auth login')) 'A logged-out Claude CLI must tell the user how to sign in.'
    Assert-True (-not (Test-Path -LiteralPath $argsFile)) 'The delegated Claude task must not launch before login succeeds.'
    Assert-Equal "Claude CLI is not logged in. Run 'claude auth login' interactively, complete sign-in, then retry the delegated task." ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) 'Claude OutFile must contain login guidance.'
    $env:FAKE_CLAUDE_LOGGED_IN = 'true'

    $env:FAKE_CLAUDE_EXIT_CODE = '0'
    $env:FAKE_CLAUDE_OUTPUT = 'too slow'
    $env:FAKE_CLAUDE_SLEEP_MS = '3000'
    $timeout = Invoke-EncodedChild '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -OutputFormat text -TimeoutSec 1 -Prompt $env:TEST_PROMPT'
    Assert-Equal 124 $timeout.ExitCode 'Claude wrapper must return 124 after its bounded timeout.'
    Remove-Item Env:FAKE_CLAUDE_SLEEP_MS

    $env:FAKE_CLAUDE_OUTPUT = 'root forwarder'
    $env:TEST_WRAPPER = $compatibilityWrapper
    $forwarded = Invoke-EncodedChild '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -OutputFormat text -TimeoutSec 10 -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $forwarded.ExitCode ('Root Claude forwarder failed: ' + ($forwarded.Output -join [Environment]::NewLine))
    Assert-Equal $prompt ([IO.File]::ReadAllText($promptFile, [Text.Encoding]::UTF8)) 'Root Claude forwarder changed the prompt.'

    $env:AGENT_DELEGATION_DEPTH = '1'
    $env:TEST_WRAPPER = $wrapper
    $recursive = Invoke-EncodedChild '& $env:TEST_WRAPPER -ClaudePath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-True ($recursive.ExitCode -ne 0) 'Claude recursion guard should reject nested delegation.'
    Remove-Item Env:AGENT_DELEGATION_DEPTH

    'claude-wrapper.Tests.ps1: all tests passed.'
}
finally {
    foreach ($name in @('TEST_WRAPPER','TEST_CLI','TEST_WORKDIR','TEST_ADDDIR','TEST_OUTFILE','TEST_RAWFILE','TEST_PROMPT','FAKE_CLAUDE_ARGS_FILE','FAKE_CLAUDE_PROMPT_FILE','FAKE_CLAUDE_CWD_FILE','FAKE_CLAUDE_DEPTH_FILE','FAKE_CLAUDE_EXIT_CODE','FAKE_CLAUDE_OUTPUT','FAKE_CLAUDE_ERROR','FAKE_CLAUDE_SLEEP_MS','FAKE_CLAUDE_LOGGED_IN','AGENT_DELEGATION_DEPTH')) {
        Remove-Item -LiteralPath ("Env:$name") -ErrorAction SilentlyContinue
    }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
