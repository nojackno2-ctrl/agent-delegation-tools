# Runs Antigravity CLI (agy) non-interactively as one isolated worker.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt,

    # Analysis is read-only by default. Writing must be selected explicitly.
    [ValidateSet('plan', 'accept-edits', 'read-only', 'workspace-write')]
    [string]$Mode = 'plan',

    [string]$Model,

    [ValidateSet('low', 'medium', 'high')]
    [string]$Effort,

    [string]$WorkDir,

    # Additional workspace directories accepted by AGY.
    [string[]]$AddDir,

    # Complete worker output, encoded as UTF-8 without a BOM.
    [string]$OutFile,

    [ValidateSet('text', 'json', 'stream-json')]
    [string]$OutputFormat = 'text',

    # AGY provides its own bounded print timeout.
    [ValidatePattern('^[1-9][0-9]*(ms|s|m|h)$')]
    [string]$PrintTimeout = '5m',

    [switch]$SkipPermissions,

    [switch]$Sandbox,

    # Explicit executable override. AGY_CLI_PATH is the environment equivalent.
    [string]$AgyPath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Resolve-ExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ParameterName = 'WorkDir'
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem' -or -not $item.PSIsContainer) {
        throw "$ParameterName must identify an existing file-system directory: $Path"
    }
    return $item.FullName
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

function Resolve-AgyExecutable {
    param([string]$RequestedPath)

    $explicitPath = $RequestedPath
    if (-not $explicitPath) { $explicitPath = $env:AGY_CLI_PATH }
    if ($explicitPath) {
        $item = Get-Item -LiteralPath $explicitPath -Force -ErrorAction Stop
        if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
            throw "AgyPath must identify an executable file: $explicitPath"
        }
        return $item.FullName
    }

    if ($env:LOCALAPPDATA) {
        $installedPath = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
        if (Test-Path -LiteralPath $installedPath -PathType Leaf) {
            return (Get-Item -LiteralPath $installedPath -Force).FullName
        }
    }

    foreach ($candidate in @('agy.exe', 'agy.cmd', 'agy.bat', 'agy')) {
        $command = Get-Command $candidate -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) { return $command.Source }
    }

    throw 'Antigravity CLI was not found. Use -AgyPath or AGY_CLI_PATH.'
}

function Format-WindowsArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

if ([string]::IsNullOrWhiteSpace($Prompt)) {
    throw 'Prompt must contain one bounded task description.'
}

$depth = 0
if ($env:AGENT_DELEGATION_DEPTH) {
    [void][int]::TryParse($env:AGENT_DELEGATION_DEPTH, [ref]$depth)
}
if ($depth -ge 1) {
    throw "Refusing recursive delegation: AGENT_DELEGATION_DEPTH=$depth."
}

$effectiveMode = switch ($Mode) {
    'read-only'       { 'plan' }
    'workspace-write' { 'accept-edits' }
    default           { $Mode }
}
if ($SkipPermissions -and $effectiveMode -ne 'accept-edits') {
    throw 'SkipPermissions requires an explicit write mode (workspace-write or accept-edits).'
}

if (-not $WorkDir) { $WorkDir = (Get-Location).ProviderPath }
$resolvedWorkDir = Resolve-ExistingDirectory $WorkDir
$resolvedAddDirs = @($AddDir | ForEach-Object {
    if (-not [string]::IsNullOrWhiteSpace($_)) {
        Resolve-ExistingDirectory -Path $_ -ParameterName 'AddDir'
    }
})
$resolvedOutFile = if ($OutFile) { Resolve-OutputPath $OutFile } else { $null }
$resolvedAgy = Resolve-AgyExecutable $AgyPath

$effectiveModel = $Model
$effectiveEffort = $Effort

if ($effectiveModel) {
    if ($effectiveModel -match '^(?i)gemini[ -]?3\.7[ -]?flash\s*\((high|medium|low)\)$') {
        $effectiveModel = 'gemini-3.7-flash'
        if (-not $effectiveEffort) { $effectiveEffort = $Matches[1].ToLowerInvariant() }
    }
    elseif ($effectiveModel -match '^(?i)gemini[ -]?3\.6[ -]?flash\s*\((high|medium|low)\)$') {
        $effectiveModel = 'gemini-3.6-flash'
        if (-not $effectiveEffort) { $effectiveEffort = $Matches[1].ToLowerInvariant() }
    }
    elseif ($effectiveModel -match '^(?i)gemini[ -]?3\.5[ -]?flash\s*\((high|medium|low)\)$') {
        $effectiveModel = 'gemini-3.5-flash'
        if (-not $effectiveEffort) { $effectiveEffort = $Matches[1].ToLowerInvariant() }
    }
    elseif ($effectiveModel -match '^(?i)gemini[ -]?3\.1[ -]?pro\s*\((high|low)\)$') {
        $effectiveModel = 'gemini-3.1-pro'
        if (-not $effectiveEffort) { $effectiveEffort = $Matches[1].ToLowerInvariant() }
    }
    elseif ($effectiveModel -match '^(?i)gemini[ -]?3\.7[ -]?flash-thinking$') {
        $effectiveModel = 'gemini-3.7-flash'
        if (-not $effectiveEffort) { $effectiveEffort = 'high' }
    }
    elseif ($effectiveModel -match '^(?i)(?:gemini[ -]?)?3\.7[ -]?flash$') {
        $effectiveModel = 'gemini-3.7-flash'
    }
    elseif ($effectiveModel -match '^(?i)(?:gemini[ -]?)?3\.6[ -]?flash$') {
        $effectiveModel = 'gemini-3.6-flash'
    }
    elseif ($effectiveModel -match '^(?i)(?:gemini[ -]?)?3\.5[ -]?flash$') {
        $effectiveModel = 'gemini-3.5-flash'
    }
    elseif ($effectiveModel -match '^(?i)(?:gemini[ -]?)?3\.1[ -]?pro$') {
        $effectiveModel = 'gemini-3.1-pro'
    }

    if ($effectiveModel -match '^(?i)gemini-3\.[567]-flash$' -and -not $effectiveEffort) {
        $effectiveEffort = 'low'
    }
    elseif ($effectiveModel -match '^(?i)gemini-3\.1-pro$' -and -not $effectiveEffort) {
        $effectiveEffort = 'low'
    }
}

$agyArgs = @('-p', $Prompt, '--mode', $effectiveMode, '--output-format', $OutputFormat, '--print-timeout', $PrintTimeout)
foreach ($directory in $resolvedAddDirs) { $agyArgs += @('--add-dir', $directory) }
if ($effectiveModel)  { $agyArgs += @('--model', $effectiveModel) }
if ($effectiveEffort) { $agyArgs += @('--effort', $effectiveEffort) }
if ($SkipPermissions) { $agyArgs += '--dangerously-skip-permissions' }
if ($Sandbox)         { $agyArgs += '--sandbox' }

$fileName = $resolvedAgy
$launchArgs = $agyArgs
$extension = [IO.Path]::GetExtension($resolvedAgy).ToLowerInvariant()
if ($extension -eq '.ps1') {
    $fileName = Join-Path $PSHOME 'powershell.exe'
    $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedAgy) + $agyArgs
}

$argumentString = ($launchArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' '
if ($extension -eq '.cmd' -or $extension -eq '.bat') {
    if (-not $env:ComSpec) { throw 'ComSpec is not set; cannot launch a cmd/bat AGY shim.' }
    $fileName = $env:ComSpec
    $innerCommand = (Format-WindowsArgument $resolvedAgy) + ' ' + (($agyArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' ')
    $argumentString = '/d /s /c "' + $innerCommand + '"'
}

$previousDepth = $env:AGENT_DELEGATION_DEPTH
$exitCode = 1
$stdout = ''
$stderr = ''
try {
    $env:AGENT_DELEGATION_DEPTH = ($depth + 1).ToString()

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $fileName
    $startInfo.Arguments = $argumentString
    $startInfo.WorkingDirectory = $resolvedWorkDir
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
    if (-not $process.Start()) { throw 'Failed to start the AGY worker process.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
}
finally {
    $env:AGENT_DELEGATION_DEPTH = $previousDepth
    if ($process) { $process.Dispose() }
}

$combinedOutput = $stdout
if ($stderr) {
    if ($combinedOutput -and -not $combinedOutput.EndsWith([Environment]::NewLine)) {
        $combinedOutput += [Environment]::NewLine
    }
    $combinedOutput += $stderr
}

$isAuthFailure = ($exitCode -ne 0) -and ($combinedOutput -match '(?i)(Authentication required|Please sign in|not logged in|sign in)')
if ($isAuthFailure) {
    $exitCode = 78
    $loginGuidance = "Antigravity CLI is not logged in. Run 'agy' interactively, complete sign-in, then retry the delegated task."
    if (-not $combinedOutput.Contains("Run 'agy' interactively")) {
        if ($combinedOutput -and -not $combinedOutput.EndsWith([Environment]::NewLine)) {
            $combinedOutput += [Environment]::NewLine
        }
        $combinedOutput += $loginGuidance
    }
    if ($stderr -and -not $stderr.Contains("Run 'agy' interactively")) {
        $stderr += [Environment]::NewLine + $loginGuidance
    }
    elseif (-not $stderr) {
        $stderr = $loginGuidance
    }
}

if ($resolvedOutFile) {
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($resolvedOutFile, $combinedOutput, $utf8NoBom)
}
if ($stdout) { [Console]::Out.Write($stdout) }
if ($stderr) { [Console]::Error.Write($stderr) }

exit $exitCode
