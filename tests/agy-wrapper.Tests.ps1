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
    $harness = Join-Path ([IO.Path]::GetTempPath()) ("agy-test-harness-{0}.ps1" -f [Guid]::NewGuid().ToString('N'))
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
$wrapper = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\agy.ps1'
$compatibilityWrapper = Join-Path $repositoryRoot 'agy.ps1'
$fakeAgy = Join-Path $PSScriptRoot 'fixtures\fake-agy.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("agy-wrapper-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $workDir = Join-Path $testRoot 'workspace'
    $addDir = Join-Path $testRoot (([char]0x5171) + ([char]0x4EAB))
    New-Item -ItemType Directory -Path $workDir, $addDir | Out-Null
    $argsFile = Join-Path $testRoot 'args.json'
    $cwdFile = Join-Path $testRoot 'cwd.txt'
    $depthFile = Join-Path $testRoot 'depth.txt'
    $outFile = Join-Path $testRoot 'agy-output.txt'
    $prompt = ([char]0x5206) + ([char]0x6790) + ' task with "double quotes", ''single quotes'', and spaces.'
    $expectedOutput = ([char]0x7D50) + ([char]0x679C) + ' "kept"'

    $env:TEST_WRAPPER = $wrapper
    $env:TEST_CLI = $fakeAgy
    $env:TEST_WORKDIR = $workDir
    $env:TEST_ADDDIR = $addDir
    $env:TEST_OUTFILE = $outFile
    $env:TEST_PROMPT = $prompt
    $env:FAKE_AGY_ARGS_FILE = $argsFile
    $env:FAKE_AGY_CWD_FILE = $cwdFile
    $env:FAKE_AGY_DEPTH_FILE = $depthFile
    $env:FAKE_AGY_EXIT_CODE = '0'
    $env:FAKE_AGY_OUTPUT = $expectedOutput

    $command = '& $env:TEST_WRAPPER -AgyPath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -AddDir $env:TEST_ADDDIR -OutFile $env:TEST_OUTFILE -OutputFormat json -Model fake-model -Effort high -PrintTimeout 7m -Prompt $env:TEST_PROMPT'
    $result = Invoke-EncodedChild $command
    Assert-Equal 0 $result.ExitCode ('AGY wrapper failed: ' + ($result.Output -join [Environment]::NewLine))

    $arguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal '-p' $arguments[0] 'AGY print mode flag is missing.'
    Assert-Equal $prompt $arguments[1] 'AGY prompt fidelity failed.'
    Assert-Equal 'plan' $arguments[[Array]::IndexOf($arguments, '--mode') + 1] 'AGY must default to read-only plan mode.'
    Assert-Equal 'json' $arguments[[Array]::IndexOf($arguments, '--output-format') + 1] 'AGY output format was not forwarded.'
    Assert-Equal '7m' $arguments[[Array]::IndexOf($arguments, '--print-timeout') + 1] 'AGY print timeout was not forwarded.'
    Assert-Equal $addDir $arguments[[Array]::IndexOf($arguments, '--add-dir') + 1] 'AGY additional directory was not forwarded.'
    Assert-Equal $workDir ([IO.File]::ReadAllText($cwdFile, [Text.Encoding]::UTF8)) 'AGY working directory was not applied.'
    Assert-Equal '1' ([IO.File]::ReadAllText($depthFile, [Text.Encoding]::UTF8)) 'AGY child should receive recursion depth 1.'
    Assert-Equal $expectedOutput ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) 'AGY output file content changed.'
    Assert-NoBom $outFile 'AGY output must be UTF-8 without a BOM.'

    $env:FAKE_AGY_EXIT_CODE = '31'
    $env:FAKE_AGY_OUTPUT = ''
    $failure = Invoke-EncodedChild '& $env:TEST_WRAPPER -AgyPath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -Mode workspace-write -Prompt $env:TEST_PROMPT'
    Assert-Equal 31 $failure.ExitCode ('AGY wrapper must propagate CLI failures. Child output: ' + ($failure.Output -join [Environment]::NewLine))
    $writeArguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal 'accept-edits' $writeArguments[[Array]::IndexOf($writeArguments, '--mode') + 1] 'Explicit workspace-write mode was not mapped to accept-edits.'

    $env:FAKE_AGY_EXIT_CODE = '19'
    $env:FAKE_AGY_OUTPUT = 'Authentication required. Please sign in.'
    $authentication = Invoke-EncodedChild '& $env:TEST_WRAPPER -AgyPath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -Mode workspace-write -OutFile $env:TEST_OUTFILE -Prompt $env:TEST_PROMPT'
    Assert-Equal 78 $authentication.ExitCode 'A logged-out AGY CLI must return the login-required exit code.'
    Assert-True (($authentication.Output -join [Environment]::NewLine).Contains("Run 'agy' interactively")) 'A logged-out AGY CLI must tell the user how to sign in.'
    Assert-True (([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)).Contains("Run 'agy' interactively")) 'AGY OutFile must preserve login guidance.'

    $env:FAKE_AGY_EXIT_CODE = '0'
    $env:FAKE_AGY_OUTPUT = 'root forwarder'
    $env:TEST_WRAPPER = $compatibilityWrapper
    $forwarded = Invoke-EncodedChild '& $env:TEST_WRAPPER -AgyPath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-Equal 0 $forwarded.ExitCode ('Root AGY forwarder failed: ' + ($forwarded.Output -join [Environment]::NewLine))
    $forwardedArguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-Equal $prompt $forwardedArguments[1] 'Root AGY forwarder changed the prompt.'

    $env:AGENT_DELEGATION_DEPTH = '1'
    $env:TEST_WRAPPER = $wrapper
    $recursive = Invoke-EncodedChild '& $env:TEST_WRAPPER -AgyPath $env:TEST_CLI -WorkDir $env:TEST_WORKDIR -Prompt $env:TEST_PROMPT'
    Assert-True ($recursive.ExitCode -ne 0) 'AGY recursion guard should reject nested delegation.'
    Remove-Item Env:AGENT_DELEGATION_DEPTH

    'agy-wrapper.Tests.ps1: all tests passed.'
}
finally {
    foreach ($name in @('TEST_WRAPPER','TEST_CLI','TEST_WORKDIR','TEST_ADDDIR','TEST_OUTFILE','TEST_PROMPT','FAKE_AGY_ARGS_FILE','FAKE_AGY_CWD_FILE','FAKE_AGY_DEPTH_FILE','FAKE_AGY_EXIT_CODE','FAKE_AGY_OUTPUT','FAKE_AGY_SLEEP_MS','AGENT_DELEGATION_DEPTH')) {
        Remove-Item -LiteralPath ("Env:$name") -ErrorAction SilentlyContinue
    }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
