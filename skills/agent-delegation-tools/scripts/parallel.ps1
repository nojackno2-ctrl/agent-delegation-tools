# Runs multiple bounded delegate.ps1 tasks concurrently, then waits at a synchronization barrier
# and writes one deterministic machine-readable summary.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TaskFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ResultsDir,

    [ValidateRange(1, 16)]
    [int]$MaxConcurrency = 3,

    [string]$WorkDir,

    [ValidateRange(1, 86400)]
    [int]$ChildTimeoutSec = 900,

    [ValidateRange(1, 86400)]
    [int]$TaskTimeoutSec = 1800,

    [string]$DelegatePath,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Resolve-FullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$BasePath = (Get-Location).ProviderPath
    )

    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Get-TaskProperty {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Task.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($property) { return $property.Value }
    return $null
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

    try {
        $taskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        if (Test-Path -LiteralPath $taskKill -PathType Leaf) {
            & $taskKill /PID $Process.Id /T /F 2>$null | Out-Null
        }
        if (-not $Process.HasExited) { $Process.Kill() }
    }
    catch {
        try { $Process.Kill() } catch { }
    }
    try { $null = $Process.WaitForExit(10000) } catch { }
}

function Start-DelegationTask {
    param([Parameter(Mandatory = $true)]$Task)

    $parameterFile = Join-Path $Task.Directory 'parameters.clixml'
    $Task.Parameters | Export-Clixml -LiteralPath $parameterFile -Depth 8 -Force
    $harness = '$ErrorActionPreference = ''Stop''; $ProgressPreference = ''SilentlyContinue''; $parameters = Import-Clixml -LiteralPath $env:AGENT_PARALLEL_PARAMETERS; & $env:AGENT_PARALLEL_DELEGATE @parameters; exit $LASTEXITCODE'
    $encodedHarness = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($harness))

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
    $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedHarness"
    $startInfo.WorkingDirectory = $Task.WorkDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['AGENT_PARALLEL_DELEGATE'] = $script:resolvedDelegatePath
    $startInfo.EnvironmentVariables['AGENT_PARALLEL_PARAMETERS'] = $parameterFile
    try {
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    } catch { }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Failed to start parallel task '$($Task.Name)'." }

    return [pscustomobject]@{
        Task = $Task
        Process = $process
        StdoutTask = $process.StandardOutput.ReadToEndAsync()
        StderrTask = $process.StandardError.ReadToEndAsync()
        StartedAt = [DateTimeOffset]::UtcNow
        Stopwatch = [Diagnostics.Stopwatch]::StartNew()
        TimedOut = $false
    }
}

function Complete-DelegationTask {
    param([Parameter(Mandatory = $true)]$Run)

    $process = $Run.Process
    try {
        if (-not $process.HasExited) {
            $Run.TimedOut = $true
            Stop-ProcessTree -Process $process
        }
        else {
            $process.WaitForExit()
        }

        $stdout = $Run.StdoutTask.Result
        $stderr = $Run.StderrTask.Result
        $exitCode = if ($Run.TimedOut) { 124 } else { $process.ExitCode }
        if ($Run.TimedOut) {
            if ($stderr -and -not $stderr.EndsWith([Environment]::NewLine)) { $stderr += [Environment]::NewLine }
            $stderr += "Parallel task '$($Run.Task.Name)' timed out after $($Run.Task.TaskTimeoutSec) seconds and its process tree was terminated."
        }

        [IO.File]::WriteAllText($Run.Task.StdoutFile, [string]$stdout, $utf8NoBom)
        [IO.File]::WriteAllText($Run.Task.StderrFile, [string]$stderr, $utf8NoBom)
        if (-not (Test-Path -LiteralPath $Run.Task.FinalFile -PathType Leaf)) {
            [IO.File]::WriteAllText($Run.Task.FinalFile, '', $utf8NoBom)
        }
        if (-not (Test-Path -LiteralPath $Run.Task.RawFile -PathType Leaf)) {
            [IO.File]::WriteAllText($Run.Task.RawFile, '', $utf8NoBom)
        }
        Remove-Item -LiteralPath (Join-Path $Run.Task.Directory 'parameters.clixml') -Force -ErrorAction SilentlyContinue

        $status = if ($Run.TimedOut) { 'timed_out' } elseif ($exitCode -eq 0) { 'succeeded' } else { 'failed' }
        $endedAt = [DateTimeOffset]::UtcNow
        $result = [ordered]@{
            name = $Run.Task.Name
            status = $status
            exitCode = $exitCode
            durationMs = [int64]$Run.Stopwatch.ElapsedMilliseconds
            startedAt = $Run.StartedAt.ToString('o')
            endedAt = $endedAt.ToString('o')
            directory = $Run.Task.Directory
            finalFile = $Run.Task.FinalFile
            rawFile = $Run.Task.RawFile
            stdoutFile = $Run.Task.StdoutFile
            stderrFile = $Run.Task.StderrFile
            resultFile = $Run.Task.ResultFile
        }
        [IO.File]::WriteAllText($Run.Task.ResultFile, ($result | ConvertTo-Json -Depth 6), $utf8NoBom)
        return [pscustomobject]$result
    }
    finally {
        $Run.Stopwatch.Stop()
        $process.Dispose()
    }
}

$depth = 0
if ($env:AGENT_DELEGATION_DEPTH) { [void][int]::TryParse($env:AGENT_DELEGATION_DEPTH, [ref]$depth) }
if ($depth -ge 1) { throw "Refusing recursive parallel delegation: AGENT_DELEGATION_DEPTH=$depth." }

$resolvedTaskFile = Resolve-FullPath $TaskFile
if (-not (Test-Path -LiteralPath $resolvedTaskFile -PathType Leaf)) { throw "Task file does not exist: $resolvedTaskFile" }

$script:resolvedDelegatePath = if ($DelegatePath) {
    Resolve-FullPath $DelegatePath
}
else {
    Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'delegate.ps1'
}
if (-not (Test-Path -LiteralPath $script:resolvedDelegatePath -PathType Leaf)) {
    throw "Delegate script does not exist: $script:resolvedDelegatePath"
}

$defaultWorkDir = if ($WorkDir) { Resolve-FullPath $WorkDir } else { (Get-Location).ProviderPath }
if (-not (Test-Path -LiteralPath $defaultWorkDir -PathType Container)) { throw "WorkDir does not exist: $defaultWorkDir" }

$resolvedResultsDir = Resolve-FullPath $ResultsDir
if (Test-Path -LiteralPath $resolvedResultsDir) {
    if (-not (Test-Path -LiteralPath $resolvedResultsDir -PathType Container)) { throw "ResultsDir is not a directory: $resolvedResultsDir" }
    if (Get-ChildItem -LiteralPath $resolvedResultsDir -Force | Select-Object -First 1) {
        throw "ResultsDir must be empty so prior evidence is not overwritten: $resolvedResultsDir"
    }
}
else {
    $resultsParent = Split-Path -Parent $resolvedResultsDir
    if (-not (Test-Path -LiteralPath $resultsParent -PathType Container)) { throw "ResultsDir parent does not exist: $resultsParent" }
}

$document = [IO.File]::ReadAllText($resolvedTaskFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
$tasksProperty = $document.PSObject.Properties | Where-Object { $_.Name -ieq 'tasks' } | Select-Object -First 1
$taskItems = @(if ($tasksProperty) { $tasksProperty.Value } else { $document })
if ($taskItems.Count -lt 1 -or $taskItems.Count -gt 64) { throw 'TaskFile must contain between 1 and 64 tasks.' }

$fieldMap = @{
    agent='Agent'; fallbackagent='FallbackAgent'; tasktype='TaskType'; sandbox='Sandbox'; model='Model'; effort='Effort'
    agymodel='AgyModel'; agyeffort='AgyEffort'; codexmodel='CodexModel'; codexeffort='CodexEffort'
    claudemodel='ClaudeModel'; claudeeffort='ClaudeEffort'; workdir='WorkDir'; adddir='AddDir'; context='Context'
    timeoutsec='TimeoutSec'; agyprinttimeout='AgyPrintTimeout'; handoffmaxchars='HandoffMaxChars'; json='Json'
    skipgitcheck='SkipGitCheck'; ephemeral='Ephemeral'; approveforme='ApproveForMe'; agyskippermissions='AgySkipPermissions'
    agypath='AgyPath'; codexpath='CodexPath'; claudepath='ClaudePath'
}
$controlFields = @('name', 'prompt', 'writescope', 'tasktimeoutsec')
$seenNames = @{}
$writeBoundaries = New-Object Collections.ArrayList
$preparedTasks = New-Object Collections.ArrayList

for ($index = 0; $index -lt $taskItems.Count; $index++) {
    $item = $taskItems[$index]
    foreach ($property in $item.PSObject.Properties) {
        $key = $property.Name.ToLowerInvariant()
        if ($key -notin $controlFields -and -not $fieldMap.ContainsKey($key)) {
            throw "Task $($index + 1) contains unsupported field '$($property.Name)'."
        }
    }

    $name = [string](Get-TaskProperty -Task $item -Name 'name')
    $prompt = [string](Get-TaskProperty -Task $item -Name 'prompt')
    if ([string]::IsNullOrWhiteSpace($name)) { throw "Task $($index + 1) requires a non-empty name." }
    if ($name.Length -gt 100) { throw "Task '$name' exceeds the 100-character name limit." }
    if ([string]::IsNullOrWhiteSpace($prompt)) { throw "Task '$name' requires a non-empty prompt." }
    $nameKey = $name.ToLowerInvariant()
    if ($seenNames.ContainsKey($nameKey)) { throw "Task names must be unique; duplicate '$name'." }
    $seenNames[$nameKey] = $index

    $parameters = @{}
    foreach ($property in $item.PSObject.Properties) {
        $key = $property.Name.ToLowerInvariant()
        if (-not $fieldMap.ContainsKey($key)) { continue }
        $targetName = $fieldMap[$key]
        $value = $property.Value
        if ($targetName -in @('Json','SkipGitCheck','Ephemeral','ApproveForMe','AgySkipPermissions')) {
            if ($value -eq $true) { $parameters[$targetName] = $true }
        }
        elseif ($null -ne $value) {
            if ($targetName -in @('FallbackAgent','AddDir')) { $parameters[$targetName] = [string[]]@($value) }
            else { $parameters[$targetName] = $value }
        }
    }

    $taskWorkDirValue = Get-TaskProperty -Task $item -Name 'workDir'
    $taskWorkDir = if ($taskWorkDirValue) { Resolve-FullPath ([string]$taskWorkDirValue) $defaultWorkDir } else { $defaultWorkDir }
    if (-not (Test-Path -LiteralPath $taskWorkDir -PathType Container)) { throw "Task '$name' WorkDir does not exist: $taskWorkDir" }
    $parameters['WorkDir'] = $taskWorkDir

    if (-not $parameters.ContainsKey('TimeoutSec')) { $parameters['TimeoutSec'] = $ChildTimeoutSec }
    $taskLimitValue = Get-TaskProperty -Task $item -Name 'taskTimeoutSec'
    $taskLimit = if ($null -ne $taskLimitValue) { [int]$taskLimitValue } else { $TaskTimeoutSec }
    if ($taskLimit -lt 1 -or $taskLimit -gt 86400) { throw "Task '$name' taskTimeoutSec must be between 1 and 86400." }

    $sandbox = if ($parameters.ContainsKey('Sandbox')) { [string]$parameters['Sandbox'] } else { 'read-only' }
    if ($sandbox -eq 'danger-full-access') { throw "Task '$name' cannot use danger-full-access in a parallel batch." }
    $scopeValues = [string[]]@((Get-TaskProperty -Task $item -Name 'writeScope'))
    $scopeValues = [string[]]@($scopeValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($sandbox -eq 'workspace-write' -and $scopeValues.Count -eq 0) {
        throw "Task '$name' uses workspace-write and requires at least one relative writeScope."
    }
    if ($sandbox -ne 'workspace-write' -and $scopeValues.Count -gt 0) {
        throw "Task '$name' declares writeScope but is not a workspace-write task."
    }

    $normalizedScopes = New-Object Collections.ArrayList
    foreach ($scope in $scopeValues) {
        if ([IO.Path]::IsPathRooted($scope)) { throw "Task '$name' writeScope must be relative: $scope" }
        $fullScope = Resolve-FullPath $scope $taskWorkDir
        $workPrefix = $taskWorkDir.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if ($fullScope -ne $taskWorkDir -and -not $fullScope.StartsWith($workPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Task '$name' writeScope escapes WorkDir: $scope"
        }
        foreach ($existing in $writeBoundaries) {
            $left = $fullScope.TrimEnd([IO.Path]::DirectorySeparatorChar)
            $right = $existing.Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
            $overlaps = $left.Equals($right, [StringComparison]::OrdinalIgnoreCase) -or
                $left.StartsWith($right + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
                $right.StartsWith($left + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
            if ($overlaps -and $existing.TaskName -ne $name) {
                throw "Parallel write scopes overlap: task '$name' ($scope) conflicts with task '$($existing.TaskName)' ($($existing.Scope))."
            }
        }
        [void]$normalizedScopes.Add($scope)
        [void]$writeBoundaries.Add([pscustomobject]@{ TaskName=$name; Scope=$scope; Path=$fullScope })
    }

    if ($normalizedScopes.Count -gt 0) {
        $scopeList = ([string[]]$normalizedScopes.ToArray()) -join ', '
        $prompt = "[Parallel delegation boundary]`nTask: $name`nYou may edit only these paths relative to the task WorkDir: $scopeList`nDo not edit files outside those paths. Do not commit, push, merge, reset, rebase, or delete branches.`n`n$prompt"
    }

    $safeName = ($name -replace '[^A-Za-z0-9._-]', '_').Trim('._-')
    if (-not $safeName) { $safeName = 'task' }
    if ($safeName.Length -gt 48) { $safeName = $safeName.Substring(0, 48) }
    $taskDirectory = Join-Path $resolvedResultsDir ("{0:D2}-{1}" -f ($index + 1), $safeName)
    $finalFile = Join-Path $taskDirectory 'final.txt'
    $rawFile = Join-Path $taskDirectory 'raw.txt'
    $parameters['Prompt'] = $prompt
    $parameters['OutFile'] = $finalFile
    $parameters['RawFile'] = $rawFile

    [void]$preparedTasks.Add([pscustomobject]@{
        Index = $index
        Name = $name
        WorkDir = $taskWorkDir
        TaskTimeoutSec = $taskLimit
        Directory = $taskDirectory
        FinalFile = $finalFile
        RawFile = $rawFile
        StdoutFile = Join-Path $taskDirectory 'stdout.txt'
        StderrFile = Join-Path $taskDirectory 'stderr.txt'
        ResultFile = Join-Path $taskDirectory 'result.json'
        Parameters = $parameters
    })
}

if (-not (Test-Path -LiteralPath $resolvedResultsDir -PathType Container)) {
    New-Item -ItemType Directory -Path $resolvedResultsDir | Out-Null
}
foreach ($task in $preparedTasks) {
    New-Item -ItemType Directory -Path $task.Directory | Out-Null
}

$pending = New-Object Collections.Queue
foreach ($task in $preparedTasks) { $pending.Enqueue($task) }
$running = New-Object Collections.ArrayList
$results = New-Object Collections.ArrayList
$batchStartedAt = [DateTimeOffset]::UtcNow

try {
    while ($pending.Count -gt 0 -or $running.Count -gt 0) {
        while ($pending.Count -gt 0 -and $running.Count -lt $MaxConcurrency) {
            $task = $pending.Dequeue()
            if (-not $Json) { Write-Host "[parallel.ps1] starting task=$($task.Name)" -ForegroundColor Cyan }
            $run = Start-DelegationTask -Task $task
            [void]$running.Add($run)
        }

        $completedAny = $false
        foreach ($run in @($running.ToArray())) {
            if (-not $run.Process.HasExited -and $run.Stopwatch.Elapsed.TotalSeconds -lt $run.Task.TaskTimeoutSec) { continue }
            if (-not $run.Process.HasExited) { $run.TimedOut = $true }
            $result = Complete-DelegationTask -Run $run
            [void]$results.Add($result)
            [void]$running.Remove($run)
            $completedAny = $true
            if (-not $Json) { Write-Host "[parallel.ps1] completed task=$($result.name) status=$($result.status) exit=$($result.exitCode)" -ForegroundColor Cyan }
        }
        if (-not $completedAny -and $running.Count -gt 0) { Start-Sleep -Milliseconds 50 }
    }
}
finally {
    foreach ($run in @($running.ToArray())) {
        try { if (-not $run.Process.HasExited) { Stop-ProcessTree -Process $run.Process } } catch { }
        try { $run.Process.Dispose() } catch { }
    }
}

$orderedResults = [object[]]@($results | Sort-Object { $seenNames[[string]$_.name.ToLowerInvariant()] })
$succeeded = @($orderedResults | Where-Object status -eq 'succeeded').Count
$timedOut = @($orderedResults | Where-Object status -eq 'timed_out').Count
$failed = $orderedResults.Count - $succeeded - $timedOut
$summary = [ordered]@{
    schemaVersion = 1
    startedAt = $batchStartedAt.ToString('o')
    endedAt = [DateTimeOffset]::UtcNow.ToString('o')
    maxConcurrency = $MaxConcurrency
    total = $orderedResults.Count
    succeeded = $succeeded
    failed = $failed
    timedOut = $timedOut
    resultsDirectory = $resolvedResultsDir
    tasks = $orderedResults
}
$summaryJson = $summary | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $resolvedResultsDir 'summary.json'), $summaryJson, $utf8NoBom)

if ($Json) { [Console]::Out.WriteLine($summaryJson) }
else { Write-Output "Parallel batch complete: $succeeded succeeded, $failed failed, $timedOut timed out. Summary: $(Join-Path $resolvedResultsDir 'summary.json')" }

if ($timedOut -gt 0) { exit 124 }
if ($failed -gt 0) { exit 1 }
exit 0
