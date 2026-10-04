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

    # AGY's own print timeout; 0 waits until the turn completes.
    [ValidatePattern('^(0|[1-9][0-9]*(ms|s|m|h))$')]
    [string]$PrintTimeout = '0',

    # 0 = no limit: wait until the child finishes.
    [ValidateRange(0, 86400)]
    [int]$TimeoutSec = 0,

    [switch]$SkipPermissions,

    [switch]$Sandbox,

    # Explicit executable override. AGY_CLI_PATH is the environment equivalent.
    [string]$AgyPath
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

if ([string]::IsNullOrWhiteSpace($Prompt)) {
    throw 'Prompt must contain one bounded task description.'
}

$depth = 0
if ($env:AGENT_DELEGATION_DEPTH) {
    [void][int]::TryParse($env:AGENT_DELEGATION_DEPTH, [ref]$depth)
}
if ($depth -ge 1) {
    [Console]::Error.WriteLine("Refusing recursive delegation: AGENT_DELEGATION_DEPTH=$depth.")
    exit $EXIT_ALL_DEPLETED
}

$effectiveMode = switch ($Mode) {
    'read-only'       { 'plan' }
    'workspace-write' { 'accept-edits' }
    default           { $Mode }
}
if ($SkipPermissions -and $effectiveMode -ne 'accept-edits') {
    throw 'SkipPermissions requires an explicit write mode (workspace-write or accept-edits).'
}
if ($SkipPermissions -and $effectiveMode -eq 'accept-edits') {
    $Sandbox = $true
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
    $trimmedModel = $effectiveModel.Trim()

    # 1. Parse effort if embedded in the model string
    $parsedEffort = $null
    if ($trimmedModel -match '^(?i)(.*?)-thinking$') {
        $trimmedModel = $Matches[1].Trim()
        $parsedEffort = 'high'
    }
    elseif ($trimmedModel -match '^(?i)(.*?)\s*\((low|medium|high)\)$') {
        $trimmedModel = $Matches[1].Trim()
        $parsedEffort = $Matches[2].ToLowerInvariant()
    }
    elseif ($trimmedModel -match '^(?i)(.*?)[ -](low|medium|high)$') {
        $trimmedModel = $Matches[1].Trim()
        $parsedEffort = $Matches[2].ToLowerInvariant()
    }

    if ($parsedEffort -and -not $effectiveEffort) {
        $effectiveEffort = $parsedEffort
    }

    # 2. Normalize known model family names
    if ($trimmedModel -match '^(?i)gpt[ -]?oss[ -]?120b(?:\s*\(medium\)|-medium)?$') {
        $trimmedModel = 'gpt-oss-120b-medium'
    }
    elseif ($trimmedModel -match '^(?i)(?:gemini[ -]?)?(\d+\.\d+)[ -]?(flash|pro)$') {
        $trimmedModel = "gemini-$($Matches[1])-$($Matches[2].ToLowerInvariant())"
    }
    elseif ($trimmedModel -match '^(?i)(?:claude[ -]?)?(opus|sonnet)[ -]?(?:5\.5|5-5)$') {
        $trimmedModel = "claude-$($Matches[1].ToLowerInvariant())-5-5"
    }

    $effectiveModel = $trimmedModel

    # 3. Default effort to medium when model is specified without effort
    if (-not $effectiveEffort -and $effectiveModel -ne 'gpt-oss-120b-medium') {
        $effectiveEffort = 'medium'
    }
}

$agyArgs = @('-p', $Prompt, '--mode', $effectiveMode, '--output-format', $OutputFormat, '--print-timeout', $PrintTimeout)
# AGY does not treat its working directory as a workspace; without --add-dir it
# runs with "No active workspace" and cannot resolve repository-relative paths.
$workspaceDirs = @($resolvedWorkDir) + @($resolvedAddDirs | Where-Object { $_ -and $_ -ne $resolvedWorkDir })
foreach ($directory in $workspaceDirs) { $agyArgs += @('--add-dir', $directory) }
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
$exitCode = $EXIT_GENERIC_FAILURE
$timedOut = $false
$stdout = ''
$stderr = ''
$process = $null
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
    if (-not $process.WaitForExit($(if ($TimeoutSec -gt 0) { $TimeoutSec * 1000 } else { -1 }))) {
        $timedOut = $true
        Stop-DelegatedProcessTree $process
        $null = $process.WaitForExit(10000)
        $exitCode = $EXIT_TIMEOUT
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

$combinedOutput = $stdout
if ($stderr) {
    if ($combinedOutput -and -not $combinedOutput.EndsWith([Environment]::NewLine)) {
        $combinedOutput += [Environment]::NewLine
    }
    $combinedOutput += $stderr
}

$isAuthFailure = ($exitCode -ne 0) -and ($combinedOutput -match '(?i)(Authentication required|Please sign in|not logged in|sign in)')
if ($isAuthFailure) {
    $exitCode = $EXIT_CONFIG_AUTH_ERROR
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
elseif (-not $timedOut -and ($exitCode -ne 0) -and ($combinedOutput -match '(?i)(insufficient[_ -]?quota|quota\s+(?:has\s+been\s+)?(?:exceeded|exhausted|depleted|used\s+up)|usage\s+(?:limit|cap)\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)|(?:daily|weekly|monthly)\s+(?:usage\s+)?limit\s+(?:reached|exceeded|exhausted)|you(?:''ve| have)\s+(?:hit|reached|exceeded)\s+(?:your\s+)?(?:usage\s+)?limit|rate[_ -]?limit(?:ed|\s+(?:reached|exceeded))?|too\s+many\s+requests|resource[_ -]?exhausted|(?:out\s+of|no|insufficient)\s+credits?|credits?\s+(?:are\s+)?(?:exhausted|depleted)|credit\s+balance\s+(?:is\s+)?(?:too\s+low|empty)|(?:http\s*)?429\b)')) {
    $exitCode = $EXIT_QUOTA_EXCEEDED
}

if ($resolvedOutFile) {
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($resolvedOutFile, $combinedOutput, $utf8NoBom)
}
if ($stdout) { [Console]::Out.Write($stdout) }
if ($stderr) { [Console]::Error.Write($stderr) }
if ($timedOut) { Write-Warning "AGY worker timed out after $TimeoutSec seconds and its process tree was terminated." }

exit $exitCode
