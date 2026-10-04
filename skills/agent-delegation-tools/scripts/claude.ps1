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

    # Claude has no native print timeout; optional wrapper bound, 0 = no limit.
    [ValidateRange(0, 86400)]
    [int]$TimeoutSec = 0,

    # Explicit executable override. CLAUDE_CLI_PATH is the environment equivalent.
    [string]$ClaudePath,

    [switch]$DryRun
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
    exit $EXIT_SUCCESS
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
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
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Windows PowerShell 5.1 (.NET Framework) has no StandardInputEncoding, so it
    # cannot share a try block with the output encodings it would otherwise skip.
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    # .NET Framework builds the stdin writer from the console input encoding and
    # flushes its preamble at Start(), so under code page 65001 the child would
    # receive a UTF-8 BOM. Swap in BOM-less UTF-8 just for the launch.
    $previousInputEncoding = $null
    try { $previousInputEncoding = [Console]::InputEncoding; [Console]::InputEncoding = $utf8NoBom } catch { }
    try {
        if (-not $process.Start()) { throw 'Failed to start the Claude worker process.' }
    }
    finally {
        if ($null -ne $previousInputEncoding) { try { [Console]::InputEncoding = $previousInputEncoding } catch { } }
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Prompt)
    $process.StandardInput.Close()

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

$isAuthFailure = ($exitCode -ne 0) -and ($stdout + "`n" + $stderr -match '(?i)(Authentication required|Please run /login|not logged in|claude auth login|invalid bearer token|unauthorized|Please sign in)')
if ($isAuthFailure) {
    $exitCode = $EXIT_CONFIG_AUTH_ERROR
    $loginGuidance = "Claude CLI is not logged in. Run 'claude auth login' interactively, complete sign-in, then retry the delegated task."
    if ($finalMessage -and -not $finalMessage.EndsWith([Environment]::NewLine)) { $finalMessage += [Environment]::NewLine }
    $finalMessage += $loginGuidance
    if ($stderr -and -not $stderr.Contains("claude auth login")) {
        $stderr += [Environment]::NewLine + $loginGuidance
    }
    elseif (-not $stderr) {
        $stderr = $loginGuidance
    }
}
elseif (-not $timedOut -and ($exitCode -ne 0 -or $finalMessage -match '(?i)(usage\s+limit|quota)') -and
    ($stdout + "`n" + $stderr + "`n" + $finalMessage -match '(?i)(insufficient[_ -]?quota|quota\s+(?:has\s+been\s+)?(?:exceeded|exhausted|depleted|used\s+up)|usage\s+(?:limit|cap)\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)|(?:daily|weekly|monthly)\s+(?:usage\s+)?limit\s+(?:reached|exceeded|exhausted)|you(?:''ve| have)\s+(?:hit|reached|exceeded)\s+(?:your\s+)?(?:usage\s+)?limit|rate[_ -]?limit(?:ed|\s+(?:reached|exceeded))?|too\s+many\s+requests|resource[_ -]?exhausted|(?:out\s+of|no|insufficient)\s+credits?|credits?\s+(?:are\s+)?(?:exhausted|depleted)|credit\s+balance\s+(?:is\s+)?(?:too\s+low|empty)|(?:http\s*)?429\b)')) {
    $exitCode = $EXIT_QUOTA_EXCEEDED
}

if ($resolvedRawFile) { [IO.File]::WriteAllText($resolvedRawFile, $stdout, $utf8NoBom) }
if ($resolvedOutFile) { [IO.File]::WriteAllText($resolvedOutFile, $finalMessage, $utf8NoBom) }

if ($finalMessage) { Write-Output $finalMessage }
if ($stderr) { [Console]::Error.Write($stderr) }
if ($timedOut) { Write-Warning "Claude worker timed out after $TimeoutSec seconds and its process tree was terminated." }

exit $exitCode
