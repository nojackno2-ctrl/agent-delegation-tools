# Runs Codex CLI non-interactively so an external agent or parent Codex can delegate bounded work.
#
# The wrapper keeps the delegated process reproducible and safe on Windows:
#
#   .\codex.ps1 'Implement the parser fix and run focused tests.'
#   .\codex.ps1 -Sandbox read-only -Ephemeral 'Inspect the parser failure.'
#   .\codex.ps1 -WorkDir 'C:\path with non-ASCII characters' '...'
#   .\codex.ps1 -AddDir 'C:\shared\fixtures' -OutFile result.txt '...'

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt,

    # Defaults to workspace-write, never the value from the user's Codex config.
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
    [string]$Sandbox = 'workspace-write',

    [string]$Model,

    # Codex exposes reasoning effort as a config override rather than a dedicated flag.
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'ultra', 'max')]
    [string]$Effort,

    [string]$WorkDir,

    # Additional writable directories. Non-ASCII paths receive collision-safe aliases too.
    [Alias('AdditionalDirectory')]
    [string[]]$AddDir,

    # Write just the final agent message here; the full transcript still goes to stdout.
    [string]$OutFile,

    [switch]$Json,

    [switch]$SkipGitCheck,

    # Do not retain rollout/session files for a one-shot worker.
    [switch]$Ephemeral,

    # Let Codex automatically review approval requests inside workspace-write.
    [switch]$ApproveForMe,

    # Explicit executable override. CODEX_CLI_PATH is the environment-variable equivalent.
    [string]$CodexPath,

    # Override the default %USERPROFILE%\codex-ws alias location.
    [string]$AliasRoot,

    # Bypass alias creation and hand Codex the real paths.
    [switch]$NoAliasPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Get-NormalizedDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -le $pathRoot.Length) { return $pathRoot }
    return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-FileSystemDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem' -or -not $item.PSIsContainer) {
        throw "$ParameterName must identify an existing file-system directory: $Path"
    }

    return Get-NormalizedDirectoryPath $item.FullName
}

function Resolve-OutputPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([IO.Path]::IsPathRooted($Path)) {
        $fullPath = [IO.Path]::GetFullPath($Path)
    }
    else {
        $fullPath = [IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
    }

    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "The output directory does not exist: $parent"
    }

    return $fullPath
}

function Resolve-CodexExecutable {
    param([string]$RequestedPath)

    $explicitPath = $RequestedPath
    if (-not $explicitPath) { $explicitPath = $env:CODEX_CLI_PATH }

    if ($explicitPath) {
        $item = Get-Item -LiteralPath $explicitPath -Force -ErrorAction Stop
        if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
            throw "CodexPath must identify an executable file: $explicitPath"
        }
        return $item.FullName
    }

    # Prefer the Desktop-managed CLI. The WindowsApps PATH alias can be discoverable
    # by Get-Command while its package ACL still rejects direct child-process launch.
    if ($env:LOCALAPPDATA) {
        $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        $desktopCodex = Get-ChildItem -LiteralPath $binRoot -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if ($desktopCodex) {
            return $desktopCodex.FullName
        }
    }

    $pathCommand = Get-Command 'codex' -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($pathCommand) {
        return $pathCommand.Source
    }

    throw 'Codex was not found in the Desktop installation or on PATH. Use -CodexPath or CODEX_CLI_PATH.'
}

function Test-SandboxSafePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path -notmatch '[^\x20-\x7E]'
}

function Get-ShortPathHash {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = (Get-NormalizedDirectoryPath $Path).ToUpperInvariant()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))
        return (($hash[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-SandboxPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Root,
        [switch]$Bypass
    )

    if ($Bypass -or (Test-SandboxSafePath $Path)) { return $Path }

    $leaf = Split-Path -Leaf $Path
    $slug = $leaf.ToLowerInvariant() -replace '[^a-z0-9]+', '-' -replace '(^-|-$)', ''
    if (-not $slug) { $slug = 'workspace' }

    # The hash prevents equal leaf names from sharing and repointing one live junction.
    $alias = Join-Path $Root ("{0}-{1}" -f $slug, (Get-ShortPathHash $Path))
    $existing = Get-Item -LiteralPath $alias -Force -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -ne 'Junction') {
        throw "$alias exists but is not a junction; refusing to modify it."
    }

    if ($existing) {
        $target = @($existing.Target)[0]
        $normalizedTarget = Get-NormalizedDirectoryPath $target
        $normalizedPath = Get-NormalizedDirectoryPath $Path
        if (-not $normalizedTarget.Equals($normalizedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$alias points to '$target', not '$Path'; refusing to repoint a live alias."
        }
    }
    else {
        New-Item -ItemType Junction -Path $alias -Target $Path | Out-Null
        Write-Host "codex.ps1: linked $alias -> $Path" -ForegroundColor DarkGray
    }

    return $alias
}

if ([string]::IsNullOrWhiteSpace($Prompt)) {
    throw 'Prompt must contain a bounded task description.'
}

$depth = 0
if ($env:AGENT_DELEGATION_DEPTH) {
    [void][int]::TryParse($env:AGENT_DELEGATION_DEPTH, [ref]$depth)
}
if ($depth -ge 1) {
    throw "Refusing recursive delegation: AGENT_DELEGATION_DEPTH=$depth."
}

if ($ApproveForMe -and $Sandbox -ne 'workspace-write') {
    throw 'ApproveForMe requires -Sandbox workspace-write so it cannot weaken a read-only invocation.'
}

if (-not $WorkDir) { $WorkDir = (Get-Location).ProviderPath }
$WorkDir = Resolve-FileSystemDirectory -Path $WorkDir -ParameterName 'WorkDir'

if (-not $NoAliasPath) {
    if (-not $AliasRoot) {
        if (-not $env:USERPROFILE) {
            throw 'USERPROFILE is not set. Use -AliasRoot or -NoAliasPath.'
        }
        $AliasRoot = Join-Path $env:USERPROFILE 'codex-ws'
    }
    if (-not (Test-SandboxSafePath $AliasRoot)) {
        throw "AliasRoot must contain only printable ASCII characters: $AliasRoot"
    }
    if (-not (Test-Path -LiteralPath $AliasRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $AliasRoot -Force | Out-Null
    }
    $AliasRoot = Resolve-FileSystemDirectory -Path $AliasRoot -ParameterName 'AliasRoot'
}

$effectiveDir = Get-SandboxPath -Path $WorkDir -Root $AliasRoot -Bypass:$NoAliasPath
$effectiveAddDirs = foreach ($directory in @($AddDir)) {
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        $resolvedDirectory = Resolve-FileSystemDirectory -Path $directory -ParameterName 'AddDir'
        Get-SandboxPath -Path $resolvedDirectory -Root $AliasRoot -Bypass:$NoAliasPath
    }
}

$resolvedOutFile = if ($OutFile) { Resolve-OutputPath $OutFile } else { $null }
$resolvedCodex = Resolve-CodexExecutable -RequestedPath $CodexPath

$codexArgs = @('exec', '--sandbox', $Sandbox, '--cd', $effectiveDir, '--color', 'never')
foreach ($directory in $effectiveAddDirs) { $codexArgs += @('--add-dir', $directory) }
if ($Model)        { $codexArgs += @('--model', $Model) }
if ($Effort)       { $codexArgs += @('-c', "model_reasoning_effort=`"$Effort`"") }
if ($resolvedOutFile) { $codexArgs += @('--output-last-message', $resolvedOutFile) }
if ($Json)         { $codexArgs += '--json' }
if ($SkipGitCheck) { $codexArgs += '--skip-git-repo-check' }
if ($Ephemeral)    { $codexArgs += '--ephemeral' }
if ($ApproveForMe) { $codexArgs += '--approve-for-me' }
$codexArgs += $Prompt

$previousDepth = $env:AGENT_DELEGATION_DEPTH
$exitCode = 1
try {
    $env:AGENT_DELEGATION_DEPTH = ($depth + 1).ToString()
    & $resolvedCodex @codexArgs
    $exitCode = $LASTEXITCODE
}
finally {
    $env:AGENT_DELEGATION_DEPTH = $previousDepth
}

exit $exitCode
