#Requires -Version 5.1
<#
.SYNOPSIS
    Synchronizes canonical skill files to root wrappers and multi-host skill directories.

.DESCRIPTION
    Maintains 100% SHA-256 parity across:
      1. skills/agent-delegation-tools/scripts/*.ps1 -> repo root *.ps1
      2. skills/agent-delegation-tools/SKILL.md -> .agents/skills/ and .claude/skills/
      3. (Optional) User global installs (~/.agents, ~/.claude, ~/.codex) if -InstallGlobal is passed.
    Then executes validate.ps1 to verify complete AST parse and SHA-256 parity.

.PARAMETER InstallGlobal
    When specified, also synchronizes the updated SKILL.md to the user's global skill directories.

.EXAMPLE
    powershell.exe -ExecutionPolicy Bypass -File .\sync.ps1
#>
[CmdletBinding()]
param(
    [switch]$InstallGlobal
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$RepoRoot = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).ProviderPath }

Write-Host "== Synchronizing agent-delegation-tools ==" -ForegroundColor Cyan

$CanonicalSkillDir = Join-Path $RepoRoot 'skills\agent-delegation-tools'
$CanonicalScriptsDir = Join-Path $CanonicalSkillDir 'scripts'
$CanonicalSkillMd = Join-Path $CanonicalSkillDir 'SKILL.md'

if (-not (Test-Path -LiteralPath $CanonicalSkillDir -PathType Container)) {
    throw "Canonical skill directory not found: $CanonicalSkillDir"
}

# 1. Sync canonical scripts to repo root
$scriptNames = @('agy.ps1', 'claude.ps1', 'codex.ps1', 'delegate.ps1', 'parallel.ps1', 'status.ps1')
foreach ($name in $scriptNames) {
    $src = Join-Path $CanonicalScriptsDir $name
    $dst = Join-Path $RepoRoot $name
    if (Test-Path -LiteralPath $src -PathType Leaf) {
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Write-Host "  [Synced] scripts\$name -> $name" -ForegroundColor Gray
    }
}

# 2. Sync SKILL.md to repo host directories
$repoHosts = @(
    (Join-Path $RepoRoot '.agents\skills\agent-delegation-tools'),
    (Join-Path $RepoRoot '.claude\skills\agent-delegation-tools')
)
foreach ($hostDir in $repoHosts) {
    if (-not (Test-Path -LiteralPath $hostDir -PathType Container)) {
        New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
    }
    $targetMd = Join-Path $hostDir 'SKILL.md'
    Copy-Item -LiteralPath $CanonicalSkillMd -Destination $targetMd -Force
    Write-Host "  [Synced] SKILL.md -> $hostDir\SKILL.md" -ForegroundColor Gray
}

# 3. Optional global installs
if ($InstallGlobal) {
    $homeDir = [Environment]::GetFolderPath('UserProfile')
    $globalHosts = @(
        (Join-Path $homeDir '.agents\skills\agent-delegation-tools'),
        (Join-Path $homeDir '.claude\skills\agent-delegation-tools'),
        (Join-Path $homeDir '.codex\skills\agent-delegation-tools')
    )
    foreach ($gHost in $globalHosts) {
        if (Test-Path -LiteralPath $gHost -PathType Container) {
            $targetMd = Join-Path $gHost 'SKILL.md'
            Copy-Item -LiteralPath $CanonicalSkillMd -Destination $targetMd -Force
            Write-Host "  [Synced Global] SKILL.md -> $targetMd" -ForegroundColor Yellow
        }
    }
}

Write-Host "`n== Running Validation ==" -ForegroundColor Cyan
& (Join-Path $RepoRoot 'validate.ps1')
