#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the agent-delegation-tools skill package into every supported agent host.

.DESCRIPTION
    Copies skills\agent-delegation-tools from this checkout into the personal skill
    directories scanned by Codex CLI, Antigravity (AGY), Claude Code, and VS Code
    Copilot Chat. Every copied file is verified by SHA-256 after the write.

    Host                    Personal skills directory
    ----------------------  --------------------------------------------------
    codex     Codex CLI     %CODEX_HOME%\skills   or  ~\.codex\skills
    agents    Antigravity   ~\.agents\skills
    claude    Claude Code   ~\.claude\skills
    copilot   VS Code       %COPILOT_HOME%\skills or  ~\.copilot\skills

    VS Code Copilot Chat also scans ~\.agents\skills and ~\.claude\skills, so the
    copilot target is only needed when neither of those hosts is installed.

    With no -Target and no -All, only hosts already present on this machine are
    installed to, so publishing a checkout does not scatter directories for
    tools the user does not have.

.PARAMETER Target
    Hosts to install into. Defaults to every host already present on this machine.

.PARAMETER All
    Install into all four hosts, creating their directories if missing.

.PARAMETER Prune
    Delete files under the installed skill directory that no longer exist in the
    source package. Without this, stale files from an older release are left alone.

.PARAMETER DryRun
    Report what would change without writing anything. -WhatIf does the same.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target copilot -DryRun

.NOTES
    Windows only: the wrappers shell out to powershell.exe and rely on NTFS
    junctions for non-ASCII workspace paths.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('codex', 'agents', 'claude', 'copilot')]
    [string[]]$Target,

    [switch]$All,

    [switch]$Prune,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SkillName = 'agent-delegation-tools'
$SourceRoot = Join-Path $PSScriptRoot "skills\$SkillName"
$IsDryRun = $DryRun.IsPresent -or $WhatIfPreference

function Get-HomeDirectory {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    if ($env:HOME) { return $env:HOME }
    throw 'Neither USERPROFILE nor HOME is set; cannot locate the personal skills directories.'
}

function Get-HostSkillsRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$HomeDirectory
    )

    switch ($Name) {
        'codex' {
            if ($env:CODEX_HOME) { return (Join-Path $env:CODEX_HOME 'skills') }
            return (Join-Path $HomeDirectory '.codex\skills')
        }
        'agents' { return (Join-Path $HomeDirectory '.agents\skills') }
        'claude' { return (Join-Path $HomeDirectory '.claude\skills') }
        'copilot' {
            if ($env:COPILOT_HOME) { return (Join-Path $env:COPILOT_HOME 'skills') }
            return (Join-Path $HomeDirectory '.copilot\skills')
        }
    }

    throw "Unknown host '$Name'."
}

function Get-FileHashHex {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'SKILL.md') -PathType Leaf)) {
    throw "Source package not found: $SourceRoot. Run this script from its own checkout."
}

$homeDirectory = Get-HomeDirectory
$hostNames = @('codex', 'agents', 'claude', 'copilot')

if ($Target) {
    $selected = @($Target | Select-Object -Unique)
}
elseif ($All) {
    $selected = $hostNames
}
else {
    $selected = @($hostNames | Where-Object {
        Test-Path -LiteralPath (Get-HostSkillsRoot -Name $_ -HomeDirectory $homeDirectory) -PathType Container
    })

    if (-not $selected) {
        Write-Host 'No agent host directory was found on this machine.' -ForegroundColor Yellow
        Write-Host 'Pass -All to create them, or -Target <codex|agents|claude|copilot> to pick one.'
        exit 1
    }
}

# Relative paths of every file in the source package.
$sourceFiles = @(
    Get-ChildItem -LiteralPath $SourceRoot -Recurse -File |
        ForEach-Object { $_.FullName.Substring($SourceRoot.Length).TrimStart('\', '/') }
)

if (-not $sourceFiles) {
    throw "Source package is empty: $SourceRoot"
}

Write-Host "Source : $SourceRoot"
Write-Host "Files  : $($sourceFiles.Count)"
if ($IsDryRun) { Write-Host 'Mode   : dry run (nothing is written)' -ForegroundColor Yellow }
Write-Host ''

$failed = 0

foreach ($hostName in $selected) {
    $skillsRoot = Get-HostSkillsRoot -Name $hostName -HomeDirectory $homeDirectory
    $destinationRoot = Join-Path $skillsRoot $SkillName

    Write-Host ("{0,-8} -> {1}" -f $hostName, $destinationRoot)

    $added = 0
    $updated = 0
    $unchanged = 0
    $pruned = 0

    foreach ($relative in $sourceFiles) {
        $sourcePath = Join-Path $SourceRoot $relative
        $destinationPath = Join-Path $destinationRoot $relative
        $sourceHash = Get-FileHashHex -Path $sourcePath

        $exists = Test-Path -LiteralPath $destinationPath -PathType Leaf
        if ($exists -and (Get-FileHashHex -Path $destinationPath) -eq $sourceHash) {
            $unchanged++
            continue
        }

        if ($exists) { $updated++ } else { $added++ }
        Write-Host ("           {0} {1}" -f $(if ($exists) { 'update' } else { 'add   ' }), $relative)

        if ($IsDryRun) { continue }

        $parent = Split-Path -Parent $destinationPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }

        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force

        if ((Get-FileHashHex -Path $destinationPath) -ne $sourceHash) {
            Write-Host ("           FAILED verification: {0}" -f $relative) -ForegroundColor Red
            $failed++
        }
    }

    if ($Prune -and (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
        $stale = @(
            Get-ChildItem -LiteralPath $destinationRoot -Recurse -File |
                ForEach-Object { $_.FullName.Substring($destinationRoot.Length).TrimStart('\', '/') } |
                Where-Object { $sourceFiles -notcontains $_ }
        )

        foreach ($relative in $stale) {
            $pruned++
            Write-Host ("           prune  {0}" -f $relative) -ForegroundColor DarkYellow
            if (-not $IsDryRun) {
                Remove-Item -LiteralPath (Join-Path $destinationRoot $relative) -Force
            }
        }
    }

    Write-Host ("           added {0}, updated {1}, unchanged {2}, pruned {3}" -f $added, $updated, $unchanged, $pruned)
    Write-Host ''
}

if ($failed -gt 0) {
    Write-Host "$failed file(s) failed SHA-256 verification." -ForegroundColor Red
    exit 1
}

if ($IsDryRun) {
    Write-Host 'Dry run complete. Re-run without -DryRun to apply.'
}
else {
    Write-Host 'Install complete; every copied file matched its source hash.' -ForegroundColor Green
}

exit 0
