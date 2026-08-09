# Runs Codex CLI non-interactively so an external agent or parent Codex can delegate bounded work.
#
# Targets the current working directory unless -WorkDir says otherwise:
#
#   .\codex.ps1 "add a foo() helper to app/world.mjs"
#   .\codex.ps1 -Sandbox read-only "explain how app/scene3d.mjs builds the scene"
#   .\codex.ps1 -WorkDir "C:\?Ｙ??脣?\蝔?閮剛?\Aperture World" "..."
#   .\codex.ps1 -OutFile result.txt "..."   # final message only, no transcript
#
# Two Windows-specific problems this wraps around:
#
#   1. The installer drops codex.exe into a hash-named folder that changes on every
#      update, so the path is resolved at call time rather than hardcoded.
#   2. Codex's Windows sandbox cannot set a working directory whose path contains
#      non-ASCII characters - the spawned shell silently lands in C:\ instead, which
#      breaks every relative path and makes git report "not a git repository". Since
#      everything here lives under C:\?Ｙ??脣?\蝔?閮剛?\, we hand Codex an ASCII
#      junction pointing at the same files. Same repo, same files, spellable path.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    # Defaults to workspace-write, NOT the danger-full-access in ~/.codex/config.toml.
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
    [string]$Sandbox = 'workspace-write',

    [string]$Model,

    # Reasoning effort. Codex has no flag for this - it is a config override.
    # Omitted means whatever ~/.codex/config.toml says (currently medium).
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'ultra', 'max')]
    [string]$Effort,

    [string]$WorkDir,

    # Write just the agent's final message here; the full transcript still goes to stdout.
    [string]$OutFile,

    [switch]$Json,

    [switch]$SkipGitCheck,

    # Bypass the junction and hand Codex the real path (expect the cwd bug above).
    [switch]$NoAliasPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $WorkDir) { $WorkDir = (Get-Location).Path }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
if (-not (Test-Path -LiteralPath $binRoot)) {
    throw "Codex is not installed - no such directory: $binRoot"
}

$codex = Get-ChildItem $binRoot -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $codex) {
    throw "Could not find codex.exe under $binRoot"
}

# A path is sandbox-safe only if it is pure printable ASCII.
function Test-SandboxSafePath([string]$Path) {
    return $Path -notmatch '[^\x20-\x7E]'
}

$effectiveDir = $WorkDir
if (-not $NoAliasPath -and -not (Test-SandboxSafePath $WorkDir)) {
    $slug = (Split-Path -Leaf $WorkDir).ToLowerInvariant() -replace '[^a-z0-9]+', '-' -replace '(^-|-$)', ''
    if (-not $slug) { $slug = 'workspace' }

    $aliasRoot = Join-Path $env:USERPROFILE 'codex-ws'
    $alias = Join-Path $aliasRoot $slug

    if (-not (Test-Path -LiteralPath $aliasRoot)) {
        New-Item -ItemType Directory -Path $aliasRoot | Out-Null
    }

    $existing = Get-Item -LiteralPath $alias -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -ne 'Junction') {
        throw "$alias exists but is not a junction - refusing to touch it."
    }
    if ($existing -and $existing.Target -notcontains $WorkDir) {
        # Repoint a stale junction rather than silently pointing Codex at the wrong repo.
        Remove-Item -LiteralPath $alias -Force
        $existing = $null
    }
    if (-not $existing) {
        New-Item -ItemType Junction -Path $alias -Target $WorkDir | Out-Null
        Write-Host "codex.ps1: linked $alias -> $WorkDir" -ForegroundColor DarkGray
    }

    $effectiveDir = $alias
}

$codexArgs = @('exec', '--sandbox', $Sandbox, '--cd', $effectiveDir, '--color', 'never')
if ($Model)        { $codexArgs += @('--model', $Model) }
if ($Effort)       { $codexArgs += @('-c', "model_reasoning_effort=`"$Effort`"") }
if ($OutFile)      { $codexArgs += @('--output-last-message', $OutFile) }
if ($Json)         { $codexArgs += '--json' }
if ($SkipGitCheck) { $codexArgs += '--skip-git-repo-check' }
$codexArgs += $Prompt

& $codex.FullName @codexArgs
exit $LASTEXITCODE
