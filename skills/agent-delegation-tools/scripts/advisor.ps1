# Advisor Mode wrapper: consults the strongest callable model of AGY, Codex, or Claude
# in read-only mode so a cheaper executor model can get top-tier guidance without handing off edits.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Question,

    [string]$Context,

    [ValidateSet('auto', 'agy', 'codex', 'claude')]
    [string]$Advisor = 'auto',

    [Alias('FallbackAgents')]
    [string[]]$FallbackAgent = @(),

    [string]$Model,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$Effort,

    [string]$WorkDir,

    [string[]]$AddDir,

    [string]$OutFile,

    [ValidateRange(0, 86400)]
    [int]$TimeoutSec = 0,

    [switch]$BalanceQuota,

    [switch]$Json,

    [string]$AgyPath,

    [string]$CodexPath,

    [string]$ClaudePath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$EXIT_SUCCESS = 0
$EXIT_GENERIC_FAILURE = 1
$EXIT_QUOTA_EXCEEDED = 10
$EXIT_ALL_DEPLETED = 75
$EXIT_CONFIG_AUTH_ERROR = 78
$EXIT_ENVIRONMENT_FAILURE = 79
$EXIT_TIMEOUT = 124
$EXIT_CANCELLED = 130

if ([string]::IsNullOrWhiteSpace($Question)) {
    throw 'Question must contain a non-empty consultation prompt.'
}

$depth = 0
if ($env:AGENT_DELEGATION_DEPTH) {
    [void][int]::TryParse($env:AGENT_DELEGATION_DEPTH, [ref]$depth)
}
if ($depth -ge 1) {
    [Console]::Error.WriteLine("Refusing recursive delegation: AGENT_DELEGATION_DEPTH=$depth.")
    exit $EXIT_ALL_DEPLETED
}

# Strongest callable advisor models per provider (kept in parity with mcp-server/src/core/defaults.ts).
$script:AdvisorBackendModel = @{
    agy    = 'gemini-4-neon'
    codex  = 'gpt-6.2-astra'
    claude = 'claude-opus-5-5'
}
$script:AdvisorBackendEffort = @{
    agy    = 'xhigh'
    codex  = 'max'
    claude = 'max'
}

$agyModel = $script:AdvisorBackendModel['agy']
$agyEffort = $script:AdvisorBackendEffort['agy']
$codexModel = $script:AdvisorBackendModel['codex']
$codexEffort = $script:AdvisorBackendEffort['codex']
$claudeModel = $script:AdvisorBackendModel['claude']
$claudeEffort = $script:AdvisorBackendEffort['claude']

if ($Advisor -ne 'auto') {
    if ($Model) {
        switch ($Advisor) {
            'agy'    { $agyModel = $Model }
            'codex'  { $codexModel = $Model }
            'claude' { $claudeModel = $Model }
        }
    }
    if ($Effort) {
        switch ($Advisor) {
            'agy'    { $agyEffort = $Effort }
            'codex'  { $codexEffort = $Effort }
            'claude' { $claudeEffort = $Effort }
        }
    }
}
elseif ($Effort) {
    $agyEffort = $Effort
    $codexEffort = $Effort
    $claudeEffort = $Effort
}

$promptLines = @(
    '[Advisor Mode - Read-Only Consultation]',
    'You are acting as a senior technical advisor for an executor agent working in this workspace.',
    'Rules:',
    '- Read-only consultation only: do NOT create, edit, or delete files, and do NOT run mutating commands.',
    '- You may inspect files in the workspace to verify facts before advising.',
    '- Provide concise, high-signal, actionable guidance: root-cause analysis, recommended solution steps, trade-offs, edge cases, and concrete file/line references so the executor can apply the fix directly.',
    '',
    'Question:',
    $Question.Trim()
)
if (-not [string]::IsNullOrWhiteSpace($Context)) {
    $promptLines += @('', 'Context / What has been tried:', $Context.Trim())
}
$advisorPrompt = $promptLines -join "`n"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDirectory) { $scriptDirectory = (Get-Location).ProviderPath }
$delegateScript = if ($env:TEST_DELEGATE) { $env:TEST_DELEGATE } else { Join-Path $scriptDirectory 'delegate.ps1' }
if (-not (Test-Path -LiteralPath $delegateScript -PathType Leaf)) {
    throw "Delegation dispatcher is missing: $delegateScript"
}

$delegateParams = @{
    Prompt       = $advisorPrompt
    Agent        = $Advisor
    TaskType     = 'analysis'
    Sandbox      = 'read-only'
    AgyModel     = $agyModel
    AgyEffort    = $agyEffort
    CodexModel   = $codexModel
    CodexEffort  = $codexEffort
    ClaudeModel  = $claudeModel
    ClaudeEffort = $claudeEffort
    TimeoutSec   = $TimeoutSec
}
if ($FallbackAgent -and $FallbackAgent.Count -gt 0) { $delegateParams['FallbackAgent'] = $FallbackAgent }
if ($WorkDir)    { $delegateParams['WorkDir'] = $WorkDir }
if ($AddDir)     { $delegateParams['AddDir'] = $AddDir }
if ($OutFile)    { $delegateParams['OutFile'] = $OutFile }
if ($BalanceQuota) { $delegateParams['BalanceQuota'] = $true }
if ($Json)       { $delegateParams['Json'] = $true }
if ($AgyPath)    { $delegateParams['AgyPath'] = $AgyPath }
if ($CodexPath)  { $delegateParams['CodexPath'] = $CodexPath }
if ($ClaudePath) { $delegateParams['ClaudePath'] = $ClaudePath }

& $delegateScript @delegateParams
exit $LASTEXITCODE
