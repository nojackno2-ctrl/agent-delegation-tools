# Unified Multi-Agent Subagent Dispatcher
#
# Routes tasks to the optimal isolated CLI worker (Codex, Antigravity, or Claude Code).
#
# Usage:
#   .\delegate.ps1 "Implement the parser fix in src/lexer.js"
#   .\delegate.ps1 -Agent agy "Explain the overall architecture in docs/"
#   .\delegate.ps1 -Agent codex -Sandbox read-only "Review PR diff for security issues"
#   .\delegate.ps1 -Agent auto -TaskType scaffolding "Generate boilerplate for CRUD API"
#
# Auto routing: analysis / scaffolding -> AGY, review -> Claude Code, implementation -> Codex.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    [ValidateSet('auto', 'codex', 'agy', 'claude')]
    [string]$Agent = 'auto',

    [ValidateSet('analysis', 'implementation', 'scaffolding', 'review')]
    [string]$TaskType = 'implementation',

    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
    [string]$Sandbox = 'workspace-write',

    [string]$Model,

    [string]$Effort,

    [string]$WorkDir,

    [string]$OutFile,

    # Claude worker only: raw json envelope alongside the final message in -OutFile.
    [string]$RawFile,

    # Claude worker only: 'isolated' skips the project's plugins/skills/hooks/CLAUDE.md.
    [ValidateSet('isolated', 'project')]
    [string]$Context = 'isolated',

    # Claude worker only: hard wall-clock limit; the Codex and AGY workers time out on their own.
    [int]$TimeoutSec,

    [switch]$Json,

    [switch]$SkipGitCheck
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Auto-selection logic if agent is 'auto'
$selectedAgent = $Agent
if ($selectedAgent -eq 'auto') {
    switch ($TaskType) {
        'analysis'       { $selectedAgent = 'agy' }
        'scaffolding'    { $selectedAgent = 'agy' }
        'review'         { $selectedAgent = 'claude' }
        'implementation' { $selectedAgent = 'codex' }
        default          { $selectedAgent = 'codex' }
    }
}

Write-Host "[delegate.ps1] Dispatching task to subagent worker: $($selectedAgent.ToUpper()) (TaskType: $TaskType)" -ForegroundColor Cyan

switch ($selectedAgent) {
    'codex' {
        $targetScript = Join-Path $scriptDir 'codex.ps1'
        $params = @{
            Prompt = $Prompt
            Sandbox = $Sandbox
        }
        if ($Model)        { $params['Model'] = $Model }
        if ($Effort)       { $params['Effort'] = $Effort }
        if ($WorkDir)      { $params['WorkDir'] = $WorkDir }
        if ($OutFile)      { $params['OutFile'] = $OutFile }
        if ($Json)         { $params['Json'] = $true }
        if ($SkipGitCheck) { $params['SkipGitCheck'] = $true }

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $targetScript @params
        exit $LASTEXITCODE
    }

    'agy' {
        $targetScript = Join-Path $scriptDir 'agy.ps1'
        $mode = if ($Sandbox -eq 'read-only' -or $TaskType -in @('analysis', 'review')) { 'plan' } else { 'accept-edits' }
        $params = @{
            Prompt = $Prompt
            Mode = $mode
        }
        if ($Model)   { $params['Model'] = $Model }
        if ($Effort)  { $params['Effort'] = $Effort }
        if ($WorkDir) { $params['WorkDir'] = $WorkDir }
        if ($OutFile) { $params['OutFile'] = $OutFile }
        if ($Json)    { $params['OutputFormat'] = 'json' }

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $targetScript @params
        exit $LASTEXITCODE
    }

    'claude' {
        $targetScript = Join-Path $scriptDir 'claude.ps1'
        # claude.ps1 accepts the sandbox vocabulary directly and maps it to a permission mode.
        $params = @{
            Prompt = $Prompt
            Mode = $Sandbox
            Context = $Context
        }
        if ($Model)      { $params['Model'] = $Model }
        if ($Effort)     { $params['Effort'] = $Effort }
        if ($WorkDir)    { $params['WorkDir'] = $WorkDir }
        if ($OutFile)    { $params['OutFile'] = $OutFile }
        if ($RawFile)    { $params['RawFile'] = $RawFile }
        if ($TimeoutSec) { $params['TimeoutSec'] = $TimeoutSec }

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $targetScript @params
        exit $LASTEXITCODE
    }
}
