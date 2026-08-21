$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\status.ps1'
$compatibilityScript = Join-Path $repositoryRoot 'status.ps1'
$fakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex-app-server.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("agent-delegation-status-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $argsFile = Join-Path $testRoot 'args.txt'
    $inputFile = Join-Path $testRoot 'initialize.txt'
    $outFile = Join-Path $testRoot 'status.json'
    $reset = [DateTimeOffset]::Now.AddHours(2).ToUnixTimeSeconds()
    $env:FAKE_CODEX_STATUS_ARGS_FILE = $argsFile
    $env:FAKE_CODEX_STATUS_INPUT_FILE = $inputFile
    $env:FAKE_CODEX_STATUS_RESPONSE = '{"id":1,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":7,"windowDurationMins":300,"resetsAt":' + $reset + '},"secondary":{"usedPercent":35,"windowDurationMins":10080,"resetsAt":' + ($reset + 3600) + '}}}}}'

    $env:FAKE_CLAUDE_STATUS_RESPONSE = @"
{
  "five_hour": {
    "utilization": 7.4,
    "resets_at": "2026-08-12T10:30:00+08:00"
  },
  "seven_day": {
    "utilization": 26.0,
    "resets_at": "2026-08-18T05:59:59+08:00"
  },
  "seven_day_opus": null,
  "extra_usage": { "is_enabled": false }
}
"@

    $env:FAKE_AGY_STATUS_RESPONSE = @"
{
  "clientModelConfigs": [
    {
      "label": "Gemini 3.7 Flash (High)",
      "quotaInfo": {
        "remainingFraction": 0.9006,
        "resetTime": "2026-08-18T05:25:50Z"
      }
    },
    {
      "label": "Claude Sonnet 4.6 (Thinking)",
      "quotaInfo": {
        "remainingFraction": 1.0,
        "resetTime": "2026-08-18T09:09:25Z"
      }
    }
  ]
}
"@

    # 1. Test All-agent query with JSON output
    $rendered = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script `
        -Agent all -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 5 -OutFile $outFile -Json
    Assert-Equal 0 $LASTEXITCODE 'Usage-status helper should complete successfully.'
    $parsedStatuses = ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) | ConvertFrom-Json
    $statuses = @($parsedStatuses | ForEach-Object { $_ })
    Assert-Equal 3 $statuses.Count 'All-provider status should return Codex, AGY, and Claude.'

    # Codex Verification
    $codex = $statuses | Where-Object agent -eq 'codex'
    Assert-Equal 'available' $codex.availability 'Codex usage should be marked available.'
    Assert-Equal 93 $codex.windows[0].remainingPercent 'Codex remaining percentage was not derived correctly.'
    Assert-Equal 7 $codex.windows[0].usedPercent 'Codex used percentage was not derived correctly.'
    Assert-Equal $reset $codex.windows[0].resetsAtUnix 'Codex reset timestamp was not preserved.'
    Assert-True (([IO.File]::ReadAllText($inputFile, [Text.Encoding]::UTF8)).StartsWith('{"method":"initialize"')) 'The app-server handshake must start with initialize and no UTF-8 BOM.'
    $arguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-True ($arguments -contains 'app-server') 'Status helper did not launch Codex app-server.'
    Assert-True ($arguments -contains 'stdio://') 'Status helper did not use the stdio transport.'

    # Claude Verification
    $claude = $statuses | Where-Object agent -eq 'claude'
    Assert-Equal 'available' $claude.availability 'Claude usage should be marked available.'
    Assert-Equal 2 @($claude.windows).Count 'Claude should have 2 active windows (5h and 7d).'
    $claude5h = $claude.windows | Where-Object name -eq 'Claude (5h)'
    Assert-Equal 7 $claude5h.usedPercent 'Claude 5h utilization should be rounded to 7%.'
    Assert-Equal 93 $claude5h.remainingPercent 'Claude 5h remaining percentage should be 93%.'
    Assert-Equal 300 $claude5h.windowDurationMins 'Claude 5h duration should be 300 minutes.'
    Assert-Equal '2026-08-12T10:30:00+08:00' $claude5h.resetsAt 'Claude 5h resetsAt should match response.'
    $claude7d = $claude.windows | Where-Object name -eq 'Claude (7d)'
    Assert-Equal 26 $claude7d.usedPercent 'Claude 7d utilization should be rounded to 26%.'
    Assert-Equal 74 $claude7d.remainingPercent 'Claude 7d remaining percentage should be 74%.'
    Assert-Equal 10080 $claude7d.windowDurationMins 'Claude 7d duration should be 10080 minutes.'

    # AGY Verification
    $agy = $statuses | Where-Object agent -eq 'agy'
    Assert-Equal 'available' $agy.availability 'AGY usage should be marked available.'
    Assert-Equal 2 @($agy.windows).Count 'AGY should have 2 active pools (Gemini and Claude/GPT).'
    $agyGemini = $agy.windows | Where-Object name -eq 'agy (Gemini)'
    Assert-Equal 10 $agyGemini.usedPercent 'AGY Gemini used percentage should be 10% (100 - 90%).'
    Assert-Equal 90 $agyGemini.remainingPercent 'AGY Gemini remaining percentage should be 90%.'
    Assert-Equal '2026-08-18T05:25:50Z' $agyGemini.resetsAt 'AGY Gemini reset timestamp should match response.'
    $agyClaude = $agy.windows | Where-Object name -eq 'agy (Claude / GPT)'
    Assert-Equal 0 $agyClaude.usedPercent 'AGY Claude/GPT used percentage should be 0%.'
    Assert-Equal 100 $agyClaude.remainingPercent 'AGY Claude/GPT remaining percentage should be 100%.'
    Assert-Equal '2026-08-18T09:09:25Z' $agyClaude.resetsAt 'AGY Claude/GPT reset timestamp should match response.'

    # 2. Test Root forwarder compatibility
    $rootJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $compatibilityScript `
        -Agent codex -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 5 -Json
    Assert-Equal 0 $LASTEXITCODE 'Root status forwarder should succeed.'
    Assert-Equal 'available' (($rootJson -join [Environment]::NewLine | ConvertFrom-Json).availability) 'Root status forwarder changed the result.'

    # 3. Test Individual Agent Queries
    $claudeOnlyJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Agent claude -Json
    Assert-Equal 0 $LASTEXITCODE 'Claude-only query should succeed.'
    $claudeOnly = $claudeOnlyJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'claude' $claudeOnly.agent 'Claude-only query returned wrong agent.'
    Assert-Equal 'available' $claudeOnly.availability 'Claude-only query should be available.'

    $agyOnlyJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Agent agy -Json
    Assert-Equal 0 $LASTEXITCODE 'AGY-only query should succeed.'
    $agyOnly = $agyOnlyJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'agy' $agyOnly.agent 'AGY-only query returned wrong agent.'
    Assert-Equal 'available' $agyOnly.availability 'AGY-only query should be available.'

    # 4. Test Text Formatting Output
    $textOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script `
        -Agent all -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 5
    Assert-Equal 0 $LASTEXITCODE 'Text-rendered status query should succeed.'
    $textCombined = $textOutput -join [Environment]::NewLine
    Assert-True ($textCombined -match 'codex codex: 93% remaining') 'Text rendering missing Codex remaining info.'
    Assert-True ($textCombined -match 'claude Claude \(5h\): 93% remaining') 'Text rendering missing Claude 5h remaining info.'
    Assert-True ($textCombined -match 'agy agy \(Gemini\): 90% remaining') 'Text rendering missing AGY Gemini remaining info.'

    # 5. Test Error Handling / Unavailable Responses
    $env:FAKE_CLAUDE_STATUS_RESPONSE = '{"error":{"message":"invalid bearer token"}}'
    $claudeErrorJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Agent claude -Json
    $claudeError = $claudeErrorJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'unavailable' $claudeError.availability 'Claude error response should be marked unavailable.'
    Assert-True ($claudeError.message -match 'invalid bearer token') 'Claude error message should be preserved.'

    $env:FAKE_AGY_STATUS_RESPONSE = '{"error":{"message":"invalid CSRF token"}}'
    $agyErrorJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Agent agy -Json
    $agyError = $agyErrorJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'unavailable' $agyError.availability 'AGY error response should be marked unavailable.'
    Assert-True ($agyError.message -match 'invalid CSRF token') 'AGY error message should be preserved.'

    # 6. Test Timeout Handling
    $env:FAKE_CODEX_STATUS_SLEEP_MS = '3000'
    $timeoutJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script `
        -Agent codex -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 1 -Json
    Assert-Equal 0 $LASTEXITCODE 'A status timeout should return structured unavailability, not crash.'
    $timeoutStatus = $timeoutJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'unavailable' $timeoutStatus.availability 'Timed-out Codex usage should be marked unavailable.'
    Assert-True ($timeoutStatus.message -match 'Timed out') 'Timed-out Codex usage should preserve timeout evidence.'

    'status.Tests.ps1: all tests passed.'
}
finally {
    foreach ($name in @('FAKE_CODEX_STATUS_ARGS_FILE','FAKE_CODEX_STATUS_INPUT_FILE','FAKE_CODEX_STATUS_RESPONSE','FAKE_CODEX_STATUS_SLEEP_MS','FAKE_CLAUDE_STATUS_RESPONSE','FAKE_AGY_STATUS_RESPONSE')) {
        Remove-Item -LiteralPath ("Env:$name") -ErrorAction SilentlyContinue
    }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
