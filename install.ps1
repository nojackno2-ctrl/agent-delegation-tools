# Installs one canonical skill package for Codex, Antigravity, and Claude.

[CmdletBinding()]
param(
    [ValidateSet('All', 'Codex', 'Antigravity', 'Claude')]
    [string[]]$Target = @('All'),

    [string]$CodexSkillsRoot,
    [string]$AntigravitySkillsRoot,
    [string]$ClaudeSkillsRoot
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $env:USERPROFILE -and (-not $CodexSkillsRoot -or -not $AntigravitySkillsRoot -or -not $ClaudeSkillsRoot)) {
    throw 'USERPROFILE is not set. Supply all three skill-root overrides explicitly.'
}

if (-not $CodexSkillsRoot) {
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $CodexSkillsRoot = Join-Path $codexHome 'skills'
}
if (-not $AntigravitySkillsRoot) { $AntigravitySkillsRoot = Join-Path $env:USERPROFILE '.agents\skills' }
if (-not $ClaudeSkillsRoot) { $ClaudeSkillsRoot = Join-Path $env:USERPROFILE '.claude\skills' }

$source = Join-Path $PSScriptRoot 'skills\agent-delegation-tools'
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md') -PathType Leaf)) {
    throw "Canonical skill source is missing: $source"
}

$requestedTargets = if ($Target -contains 'All') {
    @('Codex', 'Antigravity', 'Claude')
}
else {
    @($Target | Select-Object -Unique)
}

$destinations = @{
    Codex = $CodexSkillsRoot
    Antigravity = $AntigravitySkillsRoot
    Claude = $ClaudeSkillsRoot
}

foreach ($name in $requestedTargets) {
    $skillsRoot = [IO.Path]::GetFullPath($destinations[$name])
    if (-not (Test-Path -LiteralPath $skillsRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $skillsRoot -Force | Out-Null
    }

    $destination = Join-Path $skillsRoot 'agent-delegation-tools'
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
    }

    Get-ChildItem -LiteralPath $source -Force |
        Copy-Item -Destination $destination -Recurse -Force

    foreach ($sourceFile in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
        $relativePath = $sourceFile.FullName.Substring($source.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        $installedFile = Join-Path $destination $relativePath
        if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf)) {
            throw "$name installation is missing: $installedFile"
        }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFile).Hash) {
            throw "$name installation hash mismatch: $installedFile"
        }
    }

    Write-Output "$name skill synchronized: $destination"
}
