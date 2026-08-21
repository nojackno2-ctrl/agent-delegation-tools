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

    # Hard wall-clock bound for the complete child process tree.
    [ValidateRange(1, 86400)]
    [int]$TimeoutSec = 900,

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

    if ($env:CODEX_HOME) {
        $sandboxCodex = Join-Path $env:CODEX_HOME '.sandbox-bin\codex.exe'
        if (Test-Path -LiteralPath $sandboxCodex -PathType Leaf) { return $sandboxCodex }
    }
    if ($env:USERPROFILE) {
        $sandboxCodex = Join-Path $env:USERPROFILE '.codex\.sandbox-bin\codex.exe'
        if (Test-Path -LiteralPath $sandboxCodex -PathType Leaf) { return $sandboxCodex }
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

# Quote one argument according to the Windows CommandLineToArgvW convention.
function Format-WindowsArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Stop-DelegatedProcessTree {
    param([Diagnostics.Process]$Process)

    if (-not $Process) { return }
    try {
        if ($Process.HasExited) { return }
        $taskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        if (Test-Path -LiteralPath $taskKill -PathType Leaf) {
            & $taskKill /PID $Process.Id /T /F 2>$null | Out-Null
        }
        if (-not $Process.HasExited) { $Process.Kill() }
    }
    catch {
        try { $Process.Kill() } catch { }
    }
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

$fileName = $resolvedCodex
$launchArgs = $codexArgs
$extension = [IO.Path]::GetExtension($resolvedCodex).ToLowerInvariant()
if ($extension -eq '.ps1') {
    $fileName = Join-Path $PSHOME 'powershell.exe'
    $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedCodex) + $codexArgs
}

$argumentString = ($launchArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' '
if ($extension -eq '.cmd' -or $extension -eq '.bat') {
    if (-not $env:ComSpec) { throw 'ComSpec is not set; cannot launch a cmd/bat Codex shim.' }
    $fileName = $env:ComSpec
    $innerCommand = (Format-WindowsArgument $resolvedCodex) + ' ' + (($codexArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' ')
    $argumentString = '/d /s /c "' + $innerCommand + '"'
}

$previousDepth = $env:AGENT_DELEGATION_DEPTH
$exitCode = 1
$timedOut = $false
$stdout = ''
$stderr = ''
$process = $null
try {
    $env:AGENT_DELEGATION_DEPTH = ($depth + 1).ToString()

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $fileName
    $startInfo.Arguments = $argumentString
    $startInfo.WorkingDirectory = $effectiveDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    } catch { }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Failed to start the Codex worker process.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        $timedOut = $true
        Stop-DelegatedProcessTree $process
        $null = $process.WaitForExit(10000)
        $exitCode = 124
    }
    else {
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
}
finally {
    $env:AGENT_DELEGATION_DEPTH = $previousDepth
    if ($process) { $process.Dispose() }
}

$isAuthFailure = ($exitCode -ne 0) -and ($stdout + "`n" + $stderr -match '(?i)(Authentication required|Please sign in|not logged in|codex login|sign in to your account|unauthorized)')
if ($isAuthFailure) {
    $exitCode = 78
    $loginGuidance = "Codex CLI is not logged in. Run 'codex login' interactively, complete sign-in, then retry the delegated task."
    if ($stdout -and -not $stdout.EndsWith([Environment]::NewLine)) { $stdout += [Environment]::NewLine }
    $stdout += $loginGuidance
    if ($stderr -and -not $stderr.Contains("codex login")) {
        $stderr += [Environment]::NewLine + $loginGuidance
    }
    elseif (-not $stderr) {
        $stderr = $loginGuidance
    }
}

if ($stdout) { [Console]::Out.Write($stdout) }
if ($stderr) { [Console]::Error.Write($stderr) }
if ($timedOut) { Write-Warning "Codex worker timed out after $TimeoutSec seconds and its process tree was terminated." }

exit $exitCode
