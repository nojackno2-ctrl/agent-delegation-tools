# Tests for advisor.ps1 wrapper (read-only consultation with strongest models)
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
$advisorScript = Join-Path $repoRoot 'skills\agent-delegation-tools\scripts\advisor.ps1'
Assert-True (Test-Path -LiteralPath $advisorScript -PathType Leaf) "Missing $advisorScript"

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("advisor-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

$savedTestDelegate = $env:TEST_DELEGATE
$savedDepth = $env:AGENT_DELEGATION_DEPTH
try {
    $captureFile = Join-Path $tempDir 'captured.json'
    $fakeDelegate = Join-Path $tempDir 'fake-delegate.ps1'
    $fakeDelegateBody = @'
param(
    [string]$Prompt,
    [string]$Agent,
    [string]$TaskType,
    [string]$Sandbox,
    [string]$AgyModel,
    [string]$AgyEffort,
    [string]$CodexModel,
    [string]$CodexEffort,
    [string]$ClaudeModel,
    [string]$ClaudeEffort,
    [string[]]$FallbackAgent,
    [string]$WorkDir,
    [int]$TimeoutSec,
    [switch]$BalanceQuota,
    [switch]$Json
)
$payload = [ordered]@{
    Prompt       = $Prompt
    Agent        = $Agent
    TaskType     = $TaskType
    Sandbox      = $Sandbox
    AgyModel     = $AgyModel
    AgyEffort    = $AgyEffort
    CodexModel   = $CodexModel
    CodexEffort  = $CodexEffort
    ClaudeModel  = $ClaudeModel
    ClaudeEffort = $ClaudeEffort
    WorkDir      = $WorkDir
    BalanceQuota = [bool]$BalanceQuota
}
$payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:ADVISOR_CAPTURE_FILE -Encoding UTF8
Write-Output 'FAKE_ADVISOR_OK'
exit 0
'@
    [IO.File]::WriteAllText($fakeDelegate, $fakeDelegateBody, (New-Object Text.UTF8Encoding($false)))

    $env:TEST_DELEGATE = $fakeDelegate
    $env:ADVISOR_CAPTURE_FILE = $captureFile
    Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue

    # 1. Default auto advisor forces read-only and strongest models for all 3 providers
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $advisorScript `
        -Question 'How to fix the deadlock?' -Context 'Lock A then B' -WorkDir $tempDir -BalanceQuota
    Assert-Equal 0 $LASTEXITCODE 'advisor.ps1 default run must exit 0.'
    Assert-True (($out -join "`n") -match 'FAKE_ADVISOR_OK') 'advisor.ps1 must forward delegate output.'

    $cap = Get-Content -LiteralPath $captureFile -Raw | ConvertFrom-Json
    Assert-Equal 'auto' $cap.Agent 'Default advisor must be auto.'
    Assert-Equal 'analysis' $cap.TaskType 'Advisor must use analysis task type.'
    Assert-Equal 'read-only' $cap.Sandbox 'Advisor must enforce read-only sandbox.'
    Assert-Equal 'gemini-4-neon' $cap.AgyModel 'AGY advisor model mismatch.'
    Assert-Equal 'xhigh' $cap.AgyEffort 'AGY advisor effort mismatch.'
    Assert-Equal 'gpt-6.2-astra' $cap.CodexModel 'Codex advisor model mismatch.'
    Assert-Equal 'max' $cap.CodexEffort 'Codex advisor effort mismatch.'
    Assert-Equal 'claude-opus-5-5' $cap.ClaudeModel 'Claude advisor model mismatch.'
    Assert-Equal 'max' $cap.ClaudeEffort 'Claude advisor effort mismatch.'
    Assert-True ($cap.Prompt -match '\[Advisor Mode - Read-Only Consultation\]') 'Prompt must include Advisor header.'
    Assert-True ($cap.Prompt -match 'How to fix the deadlock\?') 'Prompt must include Question.'
    Assert-True ($cap.Prompt -match 'Lock A then B') 'Prompt must include Context.'
    Assert-True $cap.BalanceQuota 'BalanceQuota switch must be forwarded.'

    # 2. Explicit advisor + model/effort override only overrides that provider
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $advisorScript `
        -Advisor codex -Model 'gpt-6.2-sol' -Effort high -Question 'Quick check' -WorkDir $tempDir
    Assert-Equal 0 $LASTEXITCODE 'advisor.ps1 override run must exit 0.'

    $cap2 = Get-Content -LiteralPath $captureFile -Raw | ConvertFrom-Json
    Assert-Equal 'codex' $cap2.Agent 'Explicit advisor must be codex.'
    Assert-Equal 'gpt-6.2-sol' $cap2.CodexModel 'Explicit codex model override must apply.'
    Assert-Equal 'high' $cap2.CodexEffort 'Explicit codex effort override must apply.'
    Assert-Equal 'gemini-4-neon' $cap2.AgyModel 'Other providers must keep strongest advisor model.'
    Assert-Equal 'claude-opus-5-5' $cap2.ClaudeModel 'Claude must keep strongest advisor model.'

    # 3. Recursion guard refuses AGENT_DELEGATION_DEPTH >= 1 with exit 75
    $env:AGENT_DELEGATION_DEPTH = '1'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $advisorScript -Question 'Blocked' 2>&1
        $guardExit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
    Assert-Equal 75 $guardExit 'Recursion guard must exit 75.'
}
finally {
    if ($null -eq $savedTestDelegate) { Remove-Item Env:TEST_DELEGATE -ErrorAction SilentlyContinue } else { $env:TEST_DELEGATE = $savedTestDelegate }
    if ($null -eq $savedDepth) { Remove-Item Env:AGENT_DELEGATION_DEPTH -ErrorAction SilentlyContinue } else { $env:AGENT_DELEGATION_DEPTH = $savedDepth }
    Remove-Item Env:ADVISOR_CAPTURE_FILE -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}

'advisor-wrapper.Tests.ps1: all tests passed.'
