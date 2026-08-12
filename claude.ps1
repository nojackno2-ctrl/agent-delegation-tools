# Runs Claude CLI non-interactively as one isolated worker.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt,

    # Analysis is read-only by default. Writing must be selected explicitly.
    [ValidateSet('plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'manual',
                 'read-only', 'workspace-write', 'danger-full-access')]
    [string]$Mode = 'plan',

    [ValidateSet('isolated', 'project')]
    [string]$Context = 'isolated',

    [string]$Model,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$Effort,

    [string[]]$AllowedTools,

    [string[]]$DisallowedTools,

    [string[]]$AddDir,

    [string]$AppendSystemPrompt,

    # Keep one-shot child sessions ephemeral unless continuation was requested explicitly.
    [switch]$PersistSession,

    # Suggestion generation adds output and latency that delegated one-shot work does not need.
    [switch]$EnablePromptSuggestions,

    [string]$WorkDir,

    # Final assistant message, encoded as UTF-8 without a BOM.
    [string]$OutFile,

    # Complete CLI stdout, encoded as UTF-8 without a BOM.
    [string]$RawFile,

    [ValidateSet('json', 'text', 'stream-json')]
    [string]$OutputFormat = 'json',

    # Claude has no native print timeout, so the wrapper enforces one.
    [ValidateRange(1, 86400)]
    [int]$TimeoutSec = 900,

    # Explicit executable override. CLAUDE_CLI_PATH is the environment equivalent.
    [string]$ClaudePath,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$EXIT_TIMEOUT = 124

function Resolve-ExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ParameterName
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

function Resolve-ClaudeExecutable {
    param([string]$RequestedPath)

    $explicitPath = $RequestedPath
    if (-not $explicitPath) { $explicitPath = $env:CLAUDE_CLI_PATH }
    if ($explicitPath) {
        $item = Get-Item -LiteralPath $explicitPath -Force -ErrorAction Stop
        if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
            throw "ClaudePath must identify an executable file: $explicitPath"
        }
        return $item.FullName
    }

    foreach ($candidate in @('claude.exe', 'claude.cmd', 'claude.bat', 'claude')) {
        $command = Get-Command $candidate -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) { return $command.Source }
    }

    if ($env:USERPROFILE) {
        $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
        if (Test-Path -LiteralPath $fallback -PathType Leaf) {
            return (Get-Item -LiteralPath $fallback -Force).FullName
        }
    }

    throw 'Claude CLI was not found. Use -ClaudePath or CLAUDE_CLI_PATH.'
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

$permissionMode = switch ($Mode) {
    'read-only'          { 'plan' }
    'workspace-write'    { 'acceptEdits' }
    'danger-full-access' { 'bypassPermissions' }
    default              { $Mode }
}

if (-not $WorkDir) { $WorkDir = (Get-Location).ProviderPath }
$resolvedWorkDir = Resolve-ExistingDirectory -Path $WorkDir -ParameterName 'WorkDir'
$resolvedAddDirs = @($AddDir | ForEach-Object {
    if (-not [string]::IsNullOrWhiteSpace($_)) {
        Resolve-ExistingDirectory -Path $_ -ParameterName 'AddDir'
    }
})
$resolvedOutFile = if ($OutFile) { Resolve-OutputPath $OutFile } else { $null }
$resolvedRawFile = if ($RawFile) { Resolve-OutputPath $RawFile } else { $null }
$resolvedClaude = Resolve-ClaudeExecutable $ClaudePath

$claudeArgs = @('-p', '--output-format', $OutputFormat, '--permission-mode', $permissionMode)
if ($Context -eq 'isolated') { $claudeArgs += '--safe-mode' }
if (-not $PersistSession)     { $claudeArgs += '--no-session-persistence' }
$claudeArgs += @('--prompt-suggestions', $(if ($EnablePromptSuggestions) { 'true' } else { 'false' }))
if ($Model)                  { $claudeArgs += @('--model', $Model) }
if ($Effort)                 { $claudeArgs += @('--effort', $Effort) }
if ($AppendSystemPrompt)     { $claudeArgs += @('--append-system-prompt', $AppendSystemPrompt) }
if ($AllowedTools)           { $claudeArgs += @('--allowedTools') + $AllowedTools }
if ($DisallowedTools)        { $claudeArgs += @('--disallowedTools') + $DisallowedTools }
if ($resolvedAddDirs)        { $claudeArgs += @('--add-dir') + $resolvedAddDirs }

$fileName = $resolvedClaude
$launchArgs = $claudeArgs
$extension = [IO.Path]::GetExtension($resolvedClaude).ToLowerInvariant()
if ($extension -eq '.ps1') {
    $fileName = Join-Path $PSHOME 'powershell.exe'
    $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedClaude) + $claudeArgs
}

$argumentString = ($launchArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' '
if ($extension -eq '.cmd' -or $extension -eq '.bat') {
    if (-not $env:ComSpec) { throw 'ComSpec is not set; cannot launch a cmd/bat Claude shim.' }
    $fileName = $env:ComSpec
    $innerCommand = (Format-WindowsArgument $resolvedClaude) + ' ' + (($claudeArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' ')
    $argumentString = '/d /s /c "' + $innerCommand + '"'
}

if ($DryRun) {
    Write-Host "[claude.ps1] cwd: $resolvedWorkDir"
    Write-Host "[claude.ps1] command: $fileName $argumentString"
    Write-Host "[claude.ps1] prompt: $($Prompt.Length) characters via UTF-8 stdin"
    exit 0
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$previousDepth = $env:AGENT_DELEGATION_DEPTH
$exitCode = 1
$timedOut = $false
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
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardInputEncoding = $utf8NoBom
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    } catch { }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Failed to start the Claude worker process.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Prompt)
    $process.StandardInput.Close()

    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        $timedOut = $true
        try { $process.Kill() } catch { }
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

$finalMessage = $stdout
if ($OutputFormat -eq 'json' -and $stdout.Trim()) {
    try {
        $envelope = $stdout | ConvertFrom-Json
        if ($null -ne $envelope.result) { $finalMessage = [string]$envelope.result }
    }
    catch {
        Write-Warning 'Claude stdout was not a valid JSON envelope; preserving the raw output.'
    }
}

if ($resolvedRawFile) { [IO.File]::WriteAllText($resolvedRawFile, $stdout, $utf8NoBom) }
if ($resolvedOutFile) { [IO.File]::WriteAllText($resolvedOutFile, $finalMessage, $utf8NoBom) }

if ($finalMessage) { Write-Output $finalMessage }
if ($stderr) { [Console]::Error.Write($stderr) }
if ($timedOut) { Write-Warning "Claude worker timed out after $TimeoutSec seconds and was terminated." }

exit $exitCode
