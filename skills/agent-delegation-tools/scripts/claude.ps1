# Runs Claude Code CLI non-interactively as an isolated subagent worker.
#
# Usage:
#   .\claude.ps1 "Review src/api.ts for edge cases"                        # plan mode, isolated context
#   .\claude.ps1 -Mode acceptEdits -AllowedTools 'Bash(npm test)' "..."    # let the worker write + test
#   .\claude.ps1 -OutFile result.txt -RawFile raw.json "..."               # final message + raw envelope
#   .\claude.ps1 -Resume <session-id> "now apply the fix you proposed"     # multi-turn delegation
#
# What this wrapper adds on top of a bare `claude -p`:
#
#   1. Isolated worker context (-Context isolated, the default). A delegated worker that
#      inherits the parent's plugins, skills, hooks, MCP servers and CLAUDE.md pays for all
#      of it on every call, and can also inherit standing instructions meant for the parent.
#      Measured on this repo: ~48.7k prompt tokens without --safe-mode, ~7.0k with it, and
#      ~3.6k with `-Tools` narrowed. Use -Context project only when the worker genuinely
#      needs the project's own configuration.
#   2. A structured result contract. Defaults to --output-format json, so the wrapper always
#      knows the final message, the session id, the cost, and whether the run actually failed
#      (`is_error`) instead of guessing from a transcript.
#   3. Resumable workers. A session id is assigned up front and printed, so a follow-up task
#      can -Resume the same worker instead of re-sending the whole briefing.
#   4. A hard timeout. `claude` has no --print-timeout of its own (agy does), so a stuck worker
#      would otherwise block the parent forever. Times out at -TimeoutSec and exits 124.
#   5. Quota discipline. Usage-limit failures exit 10 (same convention as AGY) so the caller
#      switches backend or waits for reset instead of retrying in place.
#   6. Prompt safety. The prompt is fed through stdin, never through the command line, so
#      quotes, newlines and non-ASCII text survive Windows argument parsing intact.
#   7. A recursion guard. A delegated worker refuses to delegate again unless -AllowNested.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    # Permission mode. The read-only / workspace-write / danger-full-access spellings are
    # accepted so delegate.ps1 can forward its -Sandbox value unchanged.
    [ValidateSet('plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'manual',
                 'read-only', 'workspace-write', 'danger-full-access')]
    [string]$Mode = 'plan',

    # 'isolated' runs with --safe-mode: no plugins, skills, hooks, MCP servers or CLAUDE.md.
    # 'project' loads the project's configuration like a normal session.
    [ValidateSet('isolated', 'project')]
    [string]$Context = 'isolated',

    [string]$Model,

    # Comma-separated list is accepted by the CLI; tried in order when the primary is busy.
    [string]$FallbackModel,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$Effort,

    # Restrict the built-in tool set (e.g. 'Read','Grep','Glob' for a pure reader).
    # Pass '' to disable all tools.
    [string[]]$Tools,

    [string[]]$AllowedTools,

    [string[]]$DisallowedTools,

    [string[]]$AddDir,

    [string]$AppendSystemPrompt,

    [string]$WorkDir,

    # Final assistant message only, UTF-8 without BOM.
    [string]$OutFile,

    # Raw stdout of the CLI (the json envelope, or the stream-json lines).
    [string]$RawFile,

    [ValidateSet('json', 'text', 'stream-json')]
    [string]$OutputFormat = 'json',

    # Resume an earlier worker by session id. Mutually exclusive with -SessionId.
    [string]$Resume,

    # Pin the new worker's session id instead of letting the wrapper generate one.
    [string]$SessionId,

    # When resuming, branch into a new session instead of extending the original.
    [switch]$ForkSession,

    [double]$MaxBudgetUsd,

    [int]$TimeoutSec = 900,

    # Allow delegating from inside an already-delegated worker.
    [switch]$AllowNested,

    # Print the resolved command line and exit without calling the CLI.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$EXIT_TIMEOUT = 124
$EXIT_QUOTA = 10

# --- Recursion guard ------------------------------------------------------------------

$depth = 0
if ($env:CLAUDE_DELEGATION_DEPTH) { [void][int]::TryParse($env:CLAUDE_DELEGATION_DEPTH, [ref]$depth) }
if ($depth -ge 1 -and -not $AllowNested) {
    throw "Refusing to nest subagents: CLAUDE_DELEGATION_DEPTH=$depth. Pass -AllowNested if this is deliberate."
}

# --- Locate the CLI -------------------------------------------------------------------

$claudeExe = $null
foreach ($candidate in @('claude.exe', 'claude.cmd', 'claude.bat', 'claude')) {
    $cmd = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cmd) { $claudeExe = $cmd.Source; break }
}
if (-not $claudeExe) {
    $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $fallback) { $claudeExe = $fallback }
}
if (-not $claudeExe) {
    throw "Claude Code CLI (claude) was not found on PATH or in `$env:USERPROFILE\.local\bin."
}

# --- Resolve working directory --------------------------------------------------------

if (-not $WorkDir) { $WorkDir = (Get-Location).Path }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

# --- Build arguments ------------------------------------------------------------------

# Permission-mode aliases so one vocabulary works across all three backends.
$permissionMode = switch ($Mode) {
    'read-only'          { 'plan' }
    'workspace-write'    { 'acceptEdits' }
    'danger-full-access' { 'bypassPermissions' }
    default              { $Mode }
}

if ($Resume -and $SessionId) {
    throw 'Use -Resume or -SessionId, not both.'
}
if ($ForkSession -and -not $Resume) {
    throw '-ForkSession only applies together with -Resume.'
}

$effectiveSessionId = $null
if (-not $Resume) {
    $effectiveSessionId = if ($SessionId) { $SessionId } else { [guid]::NewGuid().ToString() }
}

$claudeArgs = @('-p', '--output-format', $OutputFormat, '--permission-mode', $permissionMode)
if ($Context -eq 'isolated')  { $claudeArgs += '--safe-mode' }
if ($Model)                   { $claudeArgs += @('--model', $Model) }
if ($FallbackModel)           { $claudeArgs += @('--fallback-model', $FallbackModel) }
if ($Effort)                  { $claudeArgs += @('--effort', $Effort) }
if ($AppendSystemPrompt)      { $claudeArgs += @('--append-system-prompt', $AppendSystemPrompt) }
if ($PSBoundParameters.ContainsKey('Tools')) { $claudeArgs += @('--tools') + $Tools }
if ($AllowedTools)            { $claudeArgs += @('--allowedTools') + $AllowedTools }
if ($DisallowedTools)         { $claudeArgs += @('--disallowedTools') + $DisallowedTools }
if ($AddDir)                  { $claudeArgs += @('--add-dir') + $AddDir }
if ($PSBoundParameters.ContainsKey('MaxBudgetUsd')) {
    # Invariant culture so a comma decimal separator never reaches the CLI.
    $claudeArgs += @('--max-budget-usd', $MaxBudgetUsd.ToString([Globalization.CultureInfo]::InvariantCulture))
}
if ($Resume)                  { $claudeArgs += @('--resume', $Resume) }
if ($effectiveSessionId)      { $claudeArgs += @('--session-id', $effectiveSessionId) }
if ($ForkSession)             { $claudeArgs += '--fork-session' }

# Everything on the command line is wrapper-controlled; the prompt goes in over stdin.
function Format-CliArgument([string]$Value) {
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

$argString = ($claudeArgs | ForEach-Object { Format-CliArgument $_ }) -join ' '

# CreateProcess cannot launch a .cmd/.bat shim directly - route those through cmd.exe.
$fileName = $claudeExe
if ($claudeExe -match '\.(cmd|bat)$') {
    $fileName = $env:ComSpec
    $argString = '/d /s /c "' + (Format-CliArgument $claudeExe) + ' ' + $argString + '"'
}

if ($DryRun) {
    Write-Host "[claude.ps1] cwd    : $WorkDir"
    Write-Host "[claude.ps1] command: $fileName $argString"
    Write-Host "[claude.ps1] prompt : $($Prompt.Length) chars via stdin"
    exit 0
}

# --- Run ------------------------------------------------------------------------------

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$promptFile = Join-Path ([IO.Path]::GetTempPath()) "claude-ps1-prompt-$stamp.txt"
$stdoutFile = Join-Path ([IO.Path]::GetTempPath()) "claude-ps1-stdout-$stamp.txt"
$stderrFile = Join-Path ([IO.Path]::GetTempPath()) "claude-ps1-stderr-$stamp.txt"

$previousDepth = $env:CLAUDE_DELEGATION_DEPTH
$exitCode = 1
$stdout = ''
$stderr = ''

try {
    [IO.File]::WriteAllText($promptFile, $Prompt, $utf8NoBom)
    $env:CLAUDE_DELEGATION_DEPTH = ($depth + 1).ToString()

    if ($effectiveSessionId) {
        Write-Host "[claude.ps1] session $effectiveSessionId (resume with -Resume $effectiveSessionId)" -ForegroundColor DarkGray
    }
    Write-Host "[claude.ps1] $permissionMode / $Context context, timeout ${TimeoutSec}s, cwd $WorkDir" -ForegroundColor DarkGray

    $proc = Start-Process -FilePath $fileName -ArgumentList $argString `
        -WorkingDirectory $WorkDir `
        -RedirectStandardInput $promptFile `
        -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError $stderrFile `
        -NoNewWindow -PassThru

    # Caching the handle keeps ExitCode readable after the timed WaitForExit overload.
    $null = $proc.Handle

    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        $null = $proc.WaitForExit(10000)
        Write-Host "[claude.ps1] timed out after ${TimeoutSec}s - worker killed." -ForegroundColor Red
        exit $EXIT_TIMEOUT
    }
    $exitCode = $proc.ExitCode

    if (Test-Path -LiteralPath $stdoutFile) { $stdout = [IO.File]::ReadAllText($stdoutFile, [Text.Encoding]::UTF8) }
    if (Test-Path -LiteralPath $stderrFile) { $stderr = [IO.File]::ReadAllText($stderrFile, [Text.Encoding]::UTF8) }
} finally {
    $env:CLAUDE_DELEGATION_DEPTH = $previousDepth
    foreach ($tmp in @($promptFile, $stdoutFile, $stderrFile)) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

# --- Interpret the result -------------------------------------------------------------

$finalMessage = $stdout
$envelope = $null

if ($OutputFormat -eq 'json' -and $stdout.Trim()) {
    try {
        $envelope = $stdout | ConvertFrom-Json
        if ($null -ne $envelope.result) { $finalMessage = [string]$envelope.result }
    } catch {
        Write-Host "[claude.ps1] could not parse the json envelope; passing stdout through." -ForegroundColor Yellow
    }
}

if ($RawFile) {
    $rawPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RawFile)
    [IO.File]::WriteAllText($rawPath, $stdout, $utf8NoBom)
}
if ($OutFile) {
    $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
    [IO.File]::WriteAllText($outPath, $finalMessage, $utf8NoBom)
}

if ($finalMessage) { Write-Output $finalMessage }
if ($stderr.Trim()) { Write-Host $stderr.TrimEnd() -ForegroundColor DarkYellow }

if ($envelope) {
    $cost = if ($null -ne $envelope.total_cost_usd) { '{0:N4}' -f $envelope.total_cost_usd } else { 'n/a' }
    $secs = if ($null -ne $envelope.duration_ms) { [int]($envelope.duration_ms / 1000) } else { 0 }
    Write-Host "[claude.ps1] turns=$($envelope.num_turns) cost=`$$cost ${secs}s session=$($envelope.session_id)" -ForegroundColor DarkGray
    if ($envelope.permission_denials -and $envelope.permission_denials.Count -gt 0) {
        Write-Host "[claude.ps1] $($envelope.permission_denials.Count) tool call(s) were denied - widen -Mode or -AllowedTools if the worker needed them." -ForegroundColor Yellow
    }
    if ($envelope.is_error -and $exitCode -eq 0) { $exitCode = 1 }
}

# Usage limits are not a retryable condition: switch backend or wait for the reset.
if ("$finalMessage`n$stderr" -match '(?i)usage limit|rate.?limit|quota (exceeded|exhausted)|429') {
    Write-Host "[claude.ps1] Anthropic usage limit hit. Switch backend (agy.ps1 / codex.ps1) or wait for the reset - do not configure an API key." -ForegroundColor Red
    exit $EXIT_QUOTA
}

exit $exitCode
