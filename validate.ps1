#Requires -Version 5.1
<#
.SYNOPSIS
    Non-side-effect smoke/parity validation for the agent-delegation-tools skill.

.DESCRIPTION
    Read-only self-check that never invokes claude/codex/agy and never writes to any
    user configuration or global skill install. It:

      1. AST-parses every Git-tracked *.ps1 file with the PowerShell language parser.
      2. Verifies the root wrapper scripts (agy/claude/codex/delegate.ps1) are
         byte-identical (SHA-256) to their canonical copies under
         skills\agent-delegation-tools\scripts\.
      3. Verifies the canonical SKILL.md matches the in-repo Antigravity (.agents) and
         Claude Code (.claude) project copies, and, only when present on this machine,
         the global Codex/Antigravity/Claude Code personal installs.
      4. Spawns each wrapper as an isolated child process (never this process, so a
         wrapper's own `exit` cannot terminate the validator) to exercise, without
         ever resolving or launching a real claude/codex/agy executable:
           - the recursion guard (AGENT_DELEGATION_DEPTH >= 1 refuses)
           - ValidateSet rejection of an invalid -Mode/-Sandbox value
           - the mode-conflict guards (codex ApproveForMe+read-only,
             agy SkipPermissions+plan, delegate danger-full-access+agy)
           - claude.ps1 -DryRun parameter mapping, using the system cmd.exe path as a
             harmless -ClaudePath stand-in (DryRun prints the command line and exits
             before anything is ever started, so the stand-in is never executed)

    All existing wrapper defaults (read-only/plan-first posture, recursion guard,
    mode conflicts) are exercised as black boxes and never modified.

.PARAMETER SkipLiveProbes
    Skip step 4 (child-process guard/DryRun probes) and only run static AST and
    parity checks. Useful on a machine where spawning powershell.exe/pwsh child
    processes is restricted.

.PARAMETER ReportPath
    Optional path to also write the results as UTF-8 JSON. Nothing is written
    anywhere else.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\validate.ps1

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\validate.ps1 -SkipLiveProbes

.NOTES
    Exit code 0 = every non-skipped check passed. Exit code 1 = at least one check
    failed. "Skipped" results (e.g. a global install that is not present on this
    machine) never cause a non-zero exit.
#>
[CmdletBinding()]
param(
    [switch]$SkipLiveProbes,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$RepoRoot = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).ProviderPath }

$script:results = New-Object System.Collections.Generic.List[pscustomobject]

function Add-CheckResult {
    param(
        [Parameter(Mandatory = $true)][string]$Category,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('Pass', 'Fail', 'Skip')][string]$Status,
        [string]$Detail = ''
    )

    $entry = [pscustomobject]@{
        Category = $Category
        Name     = $Name
        Status   = $Status
        Detail   = $Detail
    }
    $script:results.Add($entry)

    $color = switch ($Status) {
        'Pass' { 'Green' }
        'Fail' { 'Red' }
        'Skip' { 'DarkYellow' }
    }
    Write-Host ("[{0,-4}] {1} :: {2}" -f $Status, $Category, $Name) -ForegroundColor $color
    if ($Detail) { Write-Host ("        {0}" -f $Detail) -ForegroundColor DarkGray }
}

function Get-FileHashHex {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-CurrentEngineExecutablePath {
    $process = Get-Process -Id $PID -ErrorAction Stop
    return $process.Path
}

# Quote one argument according to the Windows CommandLineToArgvW convention, matching
# the wrapper scripts' own Format-WindowsArgument so probe launches use the same
# proven quoting instead of relying on ProcessStartInfo.ArgumentList (not present on
# every .NET Framework build that Windows PowerShell 5.1 may run against).
function Format-WindowsArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Test-PowerShellAst {
    param([Parameter(Mandatory = $true)][string]$Path)

    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    return $parseErrors
}

function Invoke-ProbeScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [hashtable]$EnvOverrides = @{},
        [int]$TimeoutSec = 20
    )

    $engine = Get-CurrentEngineExecutablePath
    $fullArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $engine
    $startInfo.Arguments = ($fullArguments | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' '
    $startInfo.WorkingDirectory = $RepoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $timedOut = $false
    try {
        # Accessing ProcessStartInfo.EnvironmentVariables can throw on a host
        # environment that contains case-only duplicates such as PATH and Path.
        # Apply the small probe-only override to this process just long enough
        # for the child to inherit it, then restore it immediately.
        $probeOverrides = @{ AGENT_DELEGATION_DEPTH = '0' }
        foreach ($key in @($EnvOverrides.Keys)) { $probeOverrides[[string]$key] = [string]$EnvOverrides[$key] }
        $originalEnvironment = @{}
        try {
            foreach ($key in $probeOverrides.Keys) {
                $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
                [Environment]::SetEnvironmentVariable([string]$key, [string]$probeOverrides[$key], 'Process')
            }
            if (-not $process.Start()) { throw "Failed to start probe process for $ScriptPath." }
        }
        finally {
            foreach ($key in $probeOverrides.Keys) {
                [Environment]::SetEnvironmentVariable([string]$key, $originalEnvironment[$key], 'Process')
            }
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Close()

        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            $timedOut = $true
            try { $process.Kill() } catch { }
            $null = $process.WaitForExit(5000)
        }

        return [pscustomobject]@{
            ExitCode = if ($timedOut) { -1 } else { $process.ExitCode }
            Stdout   = $stdoutTask.Result
            Stderr   = $stderrTask.Result
            TimedOut = $timedOut
        }
    }
    catch {
        throw "Probe process failed for '$ScriptPath': $($_.Exception.Message) ($($_.InvocationInfo.PositionMessage); stack=$($_.ScriptStackTrace))"
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

Write-Host ("agent-delegation-tools validation - engine: {0} ({1}) - repo: {2}" -f `
    $PSVersionTable.PSVersion, $PSVersionTable.PSEdition, $RepoRoot) -ForegroundColor Cyan
Write-Host ''

# --- 1. AST parse every tracked PowerShell script -----------------------------

Write-Host '== AST parse (git-tracked *.ps1) ==' -ForegroundColor Cyan
$gitAvailable = $true
$trackedScripts = @()
try {
    $trackedScripts = @(& git -C $RepoRoot ls-files --cached --others --exclude-standard -- '*.ps1')
    if ($LASTEXITCODE -ne 0) { throw "git ls-files exited with code $LASTEXITCODE" }
}
catch {
    $gitAvailable = $false
    Add-CheckResult -Category 'Discovery' -Name 'git ls-files -- *.ps1' -Status 'Fail' -Detail $_.ToString()
}

if ($gitAvailable) {
    if (-not $trackedScripts) {
        Add-CheckResult -Category 'Discovery' -Name 'git ls-files -- *.ps1' -Status 'Fail' -Detail 'No tracked .ps1 files were found.'
    }
    foreach ($relative in $trackedScripts) {
        $fullPath = Join-Path $RepoRoot $relative
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            Add-CheckResult -Category 'AST' -Name $relative -Status 'Fail' -Detail 'Tracked file is missing from the working tree.'
            continue
        }
        $parseErrors = Test-PowerShellAst -Path $fullPath
        if ($parseErrors.Count -eq 0) {
            Add-CheckResult -Category 'AST' -Name $relative -Status 'Pass' -Detail '0 parser errors'
        }
        else {
            $detail = ($parseErrors | ForEach-Object { $_.Message }) -join '; '
            Add-CheckResult -Category 'AST' -Name $relative -Status 'Fail' -Detail $detail
        }
    }
}
Write-Host ''

# --- 2. Root wrapper == canonical skill copy parity ----------------------------

Write-Host '== Root wrapper parity (root *.ps1 vs skills\agent-delegation-tools\scripts\*.ps1) ==' -ForegroundColor Cyan
$rootWrappers = @('agy.ps1', 'claude.ps1', 'codex.ps1', 'delegate.ps1', 'parallel.ps1', 'status.ps1')
foreach ($wrapperName in $rootWrappers) {
    $rootPath = Join-Path $RepoRoot $wrapperName
    $canonicalPath = Join-Path $RepoRoot "skills\agent-delegation-tools\scripts\$wrapperName"

    if (-not (Test-Path -LiteralPath $rootPath -PathType Leaf)) {
        Add-CheckResult -Category 'Parity' -Name "root\$wrapperName" -Status 'Fail' -Detail 'Root wrapper is missing.'
        continue
    }
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
        Add-CheckResult -Category 'Parity' -Name "root\$wrapperName" -Status 'Skip' -Detail 'No canonical counterpart under skills\agent-delegation-tools\scripts\; nothing to compare.'
        continue
    }

    $rootHash = Get-FileHashHex -Path $rootPath
    $canonicalHash = Get-FileHashHex -Path $canonicalPath
    if ($rootHash -eq $canonicalHash) {
        Add-CheckResult -Category 'Parity' -Name "root\$wrapperName" -Status 'Pass' -Detail "SHA-256 $rootHash"
    }
    else {
        Add-CheckResult -Category 'Parity' -Name "root\$wrapperName" -Status 'Fail' -Detail "root=$rootHash canonical=$canonicalHash"
    }
}
Write-Host ''

# --- 3. SKILL.md parity across canonical / Codex / Agents / Claude ------------

Write-Host '== SKILL.md parity (canonical vs Codex/Agents/Claude copies) ==' -ForegroundColor Cyan
$canonicalSkillMd = Join-Path $RepoRoot 'skills\agent-delegation-tools\SKILL.md'
if (-not (Test-Path -LiteralPath $canonicalSkillMd -PathType Leaf)) {
    Add-CheckResult -Category 'SKILL.md' -Name 'canonical' -Status 'Fail' -Detail "Missing: $canonicalSkillMd"
}
else {
    $canonicalHash = Get-FileHashHex -Path $canonicalSkillMd
    Add-CheckResult -Category 'SKILL.md' -Name 'canonical' -Status 'Pass' -Detail "SHA-256 $canonicalHash"

    $homeDirectory = $env:USERPROFILE
    if (-not $homeDirectory) { $homeDirectory = $env:HOME }

    $codexCandidates = @()
    if ($env:CODEX_HOME) { $codexCandidates += (Join-Path $env:CODEX_HOME 'skills\agent-delegation-tools\SKILL.md') }
    if ($homeDirectory) { $codexCandidates += (Join-Path $homeDirectory '.codex\skills\agent-delegation-tools\SKILL.md') }
    $codexGlobalPath = $codexCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

    $agentsGlobalPath = $null
    $claudeGlobalPath = $null
    if ($homeDirectory) {
        $agentsGlobalPath = Join-Path $homeDirectory '.agents\skills\agent-delegation-tools\SKILL.md'
        $claudeGlobalPath = Join-Path $homeDirectory '.claude\skills\agent-delegation-tools\SKILL.md'
    }

    $skillMdCopies = [ordered]@{
        'Agents (in-repo .agents\skills)'  = Join-Path $RepoRoot '.agents\skills\agent-delegation-tools\SKILL.md'
        'Claude (in-repo .claude\skills)'  = Join-Path $RepoRoot '.claude\skills\agent-delegation-tools\SKILL.md'
        'Codex (global install)'           = $codexGlobalPath
        'Agents (global ~\.agents\skills)' = $agentsGlobalPath
        'Claude (global ~\.claude\skills)' = $claudeGlobalPath
    }

    foreach ($label in $skillMdCopies.Keys) {
        $candidatePath = $skillMdCopies[$label]
        if (-not $candidatePath -or -not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            Add-CheckResult -Category 'SKILL.md' -Name $label -Status 'Skip' -Detail 'Not installed on this machine.'
            continue
        }
        $candidateHash = Get-FileHashHex -Path $candidatePath
        if ($candidateHash -eq $canonicalHash) {
            Add-CheckResult -Category 'SKILL.md' -Name $label -Status 'Pass' -Detail $candidatePath
        }
        else {
            Add-CheckResult -Category 'SKILL.md' -Name $label -Status 'Fail' -Detail "$candidatePath does not match canonical (canonical=$canonicalHash actual=$candidateHash)"
        }
    }
}
Write-Host ''

# --- 4. Live guard / DryRun probes, each in its own child process -------------

if ($SkipLiveProbes) {
    Add-CheckResult -Category 'Probe' -Name 'all live probes' -Status 'Skip' -Detail '-SkipLiveProbes was passed.'
}
else {
    Write-Host '== Recursion guard (AGENT_DELEGATION_DEPTH=1 must be refused before any external CLI is resolved) ==' -ForegroundColor Cyan
    $recursiveProbeCases = @(
        @{ Name = 'agy.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE') }
        @{ Name = 'claude.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE') }
        @{ Name = 'codex.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE') }
        @{ Name = 'delegate.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE') }
        @{ Name = 'parallel.ps1'; Arguments = @('-TaskFile', (Join-Path $RepoRoot 'AGENTS.md'), '-ResultsDir', $RepoRoot) }
    )
    foreach ($case in $recursiveProbeCases) {
        $wrapperName = $case.Name
        $scriptPath = Join-Path $RepoRoot $wrapperName
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            Add-CheckResult -Category 'Recursion guard' -Name $wrapperName -Status 'Skip' -Detail 'Script not found.'
            continue
        }
        $probe = Invoke-ProbeScript -ScriptPath $scriptPath -Arguments $case.Arguments -EnvOverrides @{ AGENT_DELEGATION_DEPTH = '1' }
        $combined = "$($probe.Stdout)`n$($probe.Stderr)"
        if (-not $probe.TimedOut -and $probe.ExitCode -ne 0 -and $combined -match 'Refusing recursive(?: parallel)? delegation') {
            Add-CheckResult -Category 'Recursion guard' -Name $wrapperName -Status 'Pass' -Detail "exit=$($probe.ExitCode)"
        }
        else {
            $detail = if ($probe.TimedOut) { 'Probe timed out.' } else { "exit=$($probe.ExitCode); output=$combined" }
            Add-CheckResult -Category 'Recursion guard' -Name $wrapperName -Status 'Fail' -Detail $detail
        }
    }
    Write-Host ''

    Write-Host '== Invalid-mode guard (ValidateSet must reject an unknown mode value) ==' -ForegroundColor Cyan
    $invalidModeProbes = @(
        @{ Script = 'codex.ps1';    Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Sandbox', 'not-a-real-mode') }
        @{ Script = 'agy.ps1';      Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Mode', 'not-a-real-mode') }
        @{ Script = 'claude.ps1';   Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Mode', 'not-a-real-mode') }
        @{ Script = 'delegate.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Sandbox', 'not-a-real-mode') }
    )
    foreach ($case in $invalidModeProbes) {
        $scriptPath = Join-Path $RepoRoot $case.Script
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            Add-CheckResult -Category 'Invalid-mode guard' -Name $case.Script -Status 'Skip' -Detail 'Script not found.'
            continue
        }
        $probe = Invoke-ProbeScript -ScriptPath $scriptPath -Arguments $case.Arguments
        if (-not $probe.TimedOut -and $probe.ExitCode -ne 0) {
            Add-CheckResult -Category 'Invalid-mode guard' -Name $case.Script -Status 'Pass' -Detail "exit=$($probe.ExitCode)"
        }
        else {
            $detail = if ($probe.TimedOut) { 'Probe timed out.' } else { "Expected a non-zero exit; got exit=$($probe.ExitCode)" }
            Add-CheckResult -Category 'Invalid-mode guard' -Name $case.Script -Status 'Fail' -Detail $detail
        }
    }
    Write-Host ''

    Write-Host '== Mode-conflict guards ==' -ForegroundColor Cyan
    $conflictProbes = @(
        @{ Name = 'codex.ps1 -ApproveForMe + -Sandbox read-only'; Script = 'codex.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Sandbox', 'read-only', '-ApproveForMe'); Pattern = 'ApproveForMe requires -Sandbox workspace-write' }
        @{ Name = 'agy.ps1 -SkipPermissions + default plan mode'; Script = 'agy.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE', '-SkipPermissions'); Pattern = 'SkipPermissions requires an explicit write mode' }
        @{ Name = 'delegate.ps1 -Agent agy + -Sandbox danger-full-access'; Script = 'delegate.ps1'; Arguments = @('-Prompt', 'VALIDATION_PROBE', '-Agent', 'agy', '-Sandbox', 'danger-full-access'); Pattern = 'does not silently map danger-full-access to AGY' }
    )
    foreach ($case in $conflictProbes) {
        $scriptPath = Join-Path $RepoRoot $case.Script
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            Add-CheckResult -Category 'Mode-conflict guard' -Name $case.Name -Status 'Skip' -Detail 'Script not found.'
            continue
        }
        $probe = Invoke-ProbeScript -ScriptPath $scriptPath -Arguments $case.Arguments
        $combined = "$($probe.Stdout)`n$($probe.Stderr)"
        if (-not $probe.TimedOut -and $probe.ExitCode -ne 0 -and $combined -match [regex]::Escape($case.Pattern)) {
            Add-CheckResult -Category 'Mode-conflict guard' -Name $case.Name -Status 'Pass' -Detail "exit=$($probe.ExitCode)"
        }
        else {
            $detail = if ($probe.TimedOut) { 'Probe timed out.' } else { "exit=$($probe.ExitCode); output=$combined" }
            Add-CheckResult -Category 'Mode-conflict guard' -Name $case.Name -Status 'Fail' -Detail $detail
        }
    }
    Write-Host ''

    Write-Host '== claude.ps1 -DryRun parameter mapping (no process is ever launched) ==' -ForegroundColor Cyan
    $claudeScript = Join-Path $RepoRoot 'claude.ps1'
    if (-not (Test-Path -LiteralPath $claudeScript -PathType Leaf)) {
        Add-CheckResult -Category 'DryRun mapping' -Name 'claude.ps1' -Status 'Skip' -Detail 'Script not found.'
    }
    else {
        # cmd.exe always exists and is only ever referenced in the printed command
        # line; -DryRun returns before Start-Process is ever called, so it is never
        # actually launched. This lets the probe run even when no real Claude CLI
        # is installed on the machine.
        $dummyClaudePath = $env:ComSpec
        $sentinelOutFile = Join-Path ([IO.Path]::GetTempPath()) ("validate-dryrun-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $sentinelOutFile) { Remove-Item -LiteralPath $sentinelOutFile -Force }

        $dryRunArguments = @(
            '-Prompt', 'VALIDATION_PROBE',
            '-DryRun',
            '-ClaudePath', $dummyClaudePath,
            '-Mode', 'workspace-write',
            '-AllowedTools', 'Bash(npm test)',
            '-OutFile', $sentinelOutFile
        )
        $probe = Invoke-ProbeScript -ScriptPath $claudeScript -Arguments $dryRunArguments
        $sentinelCreated = Test-Path -LiteralPath $sentinelOutFile -PathType Leaf
        if ($sentinelCreated) { Remove-Item -LiteralPath $sentinelOutFile -Force -ErrorAction SilentlyContinue }

        $mappingOk = -not $probe.TimedOut -and $probe.ExitCode -eq 0 -and
            $probe.Stdout -match 'acceptEdits' -and
            $probe.Stdout -match [regex]::Escape('Bash(npm test)') -and
            $probe.Stdout -match '--safe-mode' -and
            -not $sentinelCreated

        if ($mappingOk) {
            Add-CheckResult -Category 'DryRun mapping' -Name 'claude.ps1 (-Mode workspace-write -AllowedTools -Context isolated default)' -Status 'Pass' -Detail 'Mapped to acceptEdits + --safe-mode + allowedTools; -OutFile was not created.'
        }
        else {
            $detail = if ($probe.TimedOut) { 'Probe timed out.' }
            elseif ($sentinelCreated) { 'DryRun unexpectedly wrote -OutFile; that is a side effect regression.' }
            else { "exit=$($probe.ExitCode); stdout=$($probe.Stdout); stderr=$($probe.Stderr)" }
            Add-CheckResult -Category 'DryRun mapping' -Name 'claude.ps1 (-Mode workspace-write -AllowedTools -Context isolated default)' -Status 'Fail' -Detail $detail
        }

        Add-CheckResult -Category 'DryRun mapping' -Name 'codex.ps1 / agy.ps1' -Status 'Skip' -Detail 'Neither wrapper exposes a -DryRun switch; their guard checks above are the safe coverage available without invoking a real external CLI.'
    }
    Write-Host ''
}

# --- Summary --------------------------------------------------------------

$failed = @($script:results | Where-Object { $_.Status -eq 'Fail' })
$passed = @($script:results | Where-Object { $_.Status -eq 'Pass' })
$skipped = @($script:results | Where-Object { $_.Status -eq 'Skip' })

Write-Host '== Summary ==' -ForegroundColor Cyan
Write-Host ("Pass: {0}  Fail: {1}  Skip: {2}" -f $passed.Count, $failed.Count, $skipped.Count)

if ($ReportPath) {
    $resolvedReportPath = if ([IO.Path]::IsPathRooted($ReportPath)) { $ReportPath } else { Join-Path (Get-Location).ProviderPath $ReportPath }
    $script:results | ConvertTo-Json -Depth 4 | Out-File -LiteralPath $resolvedReportPath -Encoding utf8
    Write-Host "Report written: $resolvedReportPath"
}

if ($failed.Count -gt 0) {
    Write-Host 'VALIDATION FAILED' -ForegroundColor Red
    exit 1
}

Write-Host 'VALIDATION PASSED' -ForegroundColor Green
exit 0
