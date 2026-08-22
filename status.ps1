# Reads provider usage capability without starting a model turn.
# Codex exposes account/rateLimits/read through app-server.
# Claude exposes /api/oauth/usage through Anthropic OAuth credentials.
# Antigravity exposes GetCascadeModelConfigData through language_server RPC.

[CmdletBinding()]
param(
    [ValidateSet('all', 'codex', 'agy', 'claude')]
    [string]$Agent = 'all',

    [string]$CodexPath,

    [string]$WorkDir,

    [ValidateRange(1, 120)]
    [int]$TimeoutSec = 15,

    [string]$OutFile,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$utf8NoBom = New-Object Text.UTF8Encoding($false)
try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch { }
try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem' -or -not $item.PSIsContainer) {
        throw "WorkDir must identify an existing file-system directory: $Path"
    }
    return $item.FullName
}

function Resolve-OutputPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = if ([IO.Path]::IsPathRooted($Path)) {
        [IO.Path]::GetFullPath($Path)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
    }
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "The output directory does not exist: $parent"
    }
    return $fullPath
}

function Resolve-CodexExecutable {
    param([string]$RequestedPath)

    $explicitPath = if ($RequestedPath) { $RequestedPath } else { $env:CODEX_CLI_PATH }
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

    if ($env:LOCALAPPDATA) {
        $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        $desktopCodex = Get-ChildItem -LiteralPath $binRoot -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if ($desktopCodex) { return $desktopCodex.FullName }
    }

    $pathCommand = Get-Command 'codex' -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($pathCommand) { return $pathCommand.Source }
    throw 'Codex was not found. Use -CodexPath or CODEX_CLI_PATH.'
}

function Format-WindowsArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Stop-ChildProcessTree {
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

function Read-ProtocolResponse {
    param(
        [Parameter(Mandatory = $true)][IO.StreamReader]$Reader,
        [Parameter(Mandatory = $true)][int]$ResponseId,
        [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
    )

    while ($true) {
        $remaining = $DeadlineUtc - [DateTime]::UtcNow
        if ($remaining.TotalMilliseconds -le 0) {
            throw [TimeoutException]::new("Timed out waiting for Codex app-server response id=$ResponseId.")
        }
        $lineTask = $Reader.ReadLineAsync()
        if (-not $lineTask.Wait([Math]::Max(1, [Math]::Floor($remaining.TotalMilliseconds)))) {
            throw [TimeoutException]::new("Timed out waiting for Codex app-server response id=$ResponseId.")
        }
        $line = $lineTask.Result
        if ($null -eq $line) {
            throw "Codex app-server ended before response id=$ResponseId."
        }
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($null -ne $record.id -and [int]$record.id -eq $ResponseId) { return $record }
    }
}

function Get-CodexStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    $observedAt = [DateTimeOffset]::Now
    $process = $null
    $stderrTask = $null
    try {
        $args = @('app-server', '--listen', 'stdio://')
        $fileName = $Executable
        $launchArgs = $args
        $extension = [IO.Path]::GetExtension($Executable).ToLowerInvariant()
        if ($extension -eq '.ps1') {
            $fileName = Join-Path $PSHOME 'powershell.exe'
            $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Executable) + $args
        }
        $argumentString = ($launchArgs | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' '
        if ($extension -eq '.cmd' -or $extension -eq '.bat') {
            if (-not $env:ComSpec) { throw 'ComSpec is not set; cannot launch a cmd/bat Codex shim.' }
            $fileName = $env:ComSpec
            $innerCommand = (Format-WindowsArgument $Executable) + ' ' + (($args | ForEach-Object { Format-WindowsArgument ([string]$_) }) -join ' ')
            $argumentString = '/d /s /c "' + $innerCommand + '"'
        }

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $fileName
        $startInfo.Arguments = $argumentString
        $startInfo.WorkingDirectory = $Directory
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
        if (-not $process.Start()) { throw 'Failed to start Codex app-server.' }
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)

        $process.StandardInput.WriteLine('{"method":"initialize","id":0,"params":{"clientInfo":{"name":"agent_delegation_tools","title":"Agent Delegation Tools","version":"1.0.0"}}}')
        $process.StandardInput.Flush()
        $initialize = Read-ProtocolResponse -Reader $process.StandardOutput -ResponseId 0 -DeadlineUtc $deadline
        if ($null -ne $initialize.error) { throw "Codex app-server initialize failed: $($initialize.error.message)" }

        $process.StandardInput.WriteLine('{"method":"initialized","params":{}}')
        $process.StandardInput.WriteLine('{"method":"account/rateLimits/read","id":1}')
        $process.StandardInput.Flush()
        $response = Read-ProtocolResponse -Reader $process.StandardOutput -ResponseId 1 -DeadlineUtc $deadline
        if ($null -ne $response.error) { throw "Codex usage query failed: $($response.error.message)" }

        $windows = New-Object 'Collections.Generic.List[object]'
        $buckets = $response.result.rateLimitsByLimitId
        if ($null -eq $buckets -or @($buckets.PSObject.Properties).Count -eq 0) {
            $legacy = $response.result.rateLimits
            if ($null -ne $legacy) {
                $buckets = [pscustomobject]@{ codex = $legacy }
            }
        }
        foreach ($bucketProperty in @($buckets.PSObject.Properties)) {
            $bucket = $bucketProperty.Value
            $bucketName = if ($bucket.limitName) { [string]$bucket.limitName } elseif ($bucket.limitId) { [string]$bucket.limitId } else { $bucketProperty.Name }
            foreach ($windowName in @('primary', 'secondary')) {
                $window = $bucket.$windowName
                if ($null -eq $window -or $null -eq $window.usedPercent) { continue }
                $used = [Math]::Max(0, [Math]::Min(100, [int]$window.usedPercent))
                $resetUnix = if ($null -ne $window.resetsAt) { [long]$window.resetsAt } else { $null }
                $resetIso = if ($null -ne $resetUnix) { [DateTimeOffset]::FromUnixTimeSeconds($resetUnix).ToString('o') } else { $null }
                $windows.Add([ordered]@{
                    name = $(if ($windowName -eq 'primary') { $bucketName } else { "$bucketName secondary" })
                    usedPercent = $used
                    remainingPercent = 100 - $used
                    windowDurationMins = $(if ($null -ne $window.windowDurationMins) { [long]$window.windowDurationMins } else { $null })
                    resetsAt = $resetIso
                    resetsAtUnix = $resetUnix
                })
            }
        }
        if ($windows.Count -eq 0) { throw 'Codex returned no recognizable rate-limit windows.' }

        return [ordered]@{
            agent = 'codex'
            availability = 'available'
            observedAt = $observedAt.ToString('o')
            message = 'Read from Codex app-server account/rateLimits/read without starting a model turn.'
            windows = [object[]]($windows | ForEach-Object { $_ })
        }
    }
    catch {
        return [ordered]@{
            agent = 'codex'
            availability = 'unavailable'
            observedAt = $observedAt.ToString('o')
            message = $_.Exception.Message
            windows = @()
        }
    }
    finally {
        Stop-ChildProcessTree $process
        if ($process) { $process.Dispose() }
    }
}

function Parse-ClaudeUsageResponse {
    param(
        [Parameter(Mandatory = $true)][string]$RawJson,
        [Parameter(Mandatory = $true)][DateTimeOffset]$ObservedAt
    )

    $json = $RawJson | ConvertFrom-Json
    if ($null -ne $json.error) {
        $msg = if ($json.error.message) { $json.error.message } else { [string]$json.error }
        return [ordered]@{
            agent = 'claude'
            availability = 'unavailable'
            observedAt = $ObservedAt.ToString('o')
            message = "Claude usage query failed: $msg"
            windows = @()
        }
    }

    $windowDefs = @(
        @{ prop = 'five_hour';            name = 'Claude (5h)';           duration = 300 }
        @{ prop = 'seven_day';            name = 'Claude (7d)';           duration = 10080 }
        @{ prop = 'seven_day_opus';       name = 'Claude Opus (7d)';      duration = 10080 }
        @{ prop = 'seven_day_sonnet';     name = 'Claude Sonnet (7d)';    duration = 10080 }
        @{ prop = 'seven_day_oauth_apps'; name = 'Claude OAuth Apps (7d)';duration = 10080 }
        @{ prop = 'seven_day_cowork';     name = 'Claude Cowork (7d)';    duration = 10080 }
    )

    $windows = New-Object 'Collections.Generic.List[object]'
    foreach ($def in $windowDefs) {
        $propName = $def.prop
        $win = $json.$propName
        if ($null -eq $win -or $null -eq $win.utilization) { continue }

        $used = [Math]::Max(0, [Math]::Min(100, [int][Math]::Round([double]$win.utilization)))
        $resetIso = if ($win.resets_at) { [string]$win.resets_at } else { $null }
        $resetUnix = if ($resetIso) {
            try { [DateTimeOffset]::Parse($resetIso).ToUnixTimeSeconds() } catch { $null }
        } else { $null }

        $windows.Add([ordered]@{
            name = $def.name
            usedPercent = $used
            remainingPercent = 100 - $used
            windowDurationMins = $def.duration
            resetsAt = $resetIso
            resetsAtUnix = $resetUnix
        })
    }

    if ($windows.Count -eq 0) {
        return [ordered]@{
            agent = 'claude'
            availability = 'unavailable'
            observedAt = $ObservedAt.ToString('o')
            message = 'Claude responded but returned no recognizable usage windows.'
            windows = @()
        }
    }

    return [ordered]@{
        agent = 'claude'
        availability = 'available'
        observedAt = $ObservedAt.ToString('o')
        message = 'Read from Claude OAuth usage endpoint https://api.anthropic.com/api/oauth/usage.'
        windows = [object[]]($windows | ForEach-Object { $_ })
    }
}

function Get-ClaudeStatus {
    param(
        [int]$TimeoutSeconds = 15
    )

    $observedAt = [DateTimeOffset]::Now

    if ($env:FAKE_CLAUDE_STATUS_RESPONSE) {
        return Parse-ClaudeUsageResponse -RawJson $env:FAKE_CLAUDE_STATUS_RESPONSE -ObservedAt $observedAt
    }

    try {
        $credentialsPath = if ($env:CLAUDE_CONFIG_DIR) {
            Join-Path ([Environment]::ExpandEnvironmentVariables($env:CLAUDE_CONFIG_DIR)) '.credentials.json'
        } elseif ($env:USERPROFILE) {
            Join-Path $env:USERPROFILE '.claude\.credentials.json'
        } else {
            $null
        }

        if (-not $credentialsPath -or -not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
            return [ordered]@{
                agent = 'claude'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Claude Code credentials not found. Run claude auth login first.'
                windows = @()
            }
        }

        $rawCreds = [IO.File]::ReadAllText($credentialsPath, [Text.Encoding]::UTF8)
        $credsJson = $rawCreds | ConvertFrom-Json
        $accessToken = $credsJson.claudeAiOauth.accessToken
        if ([string]::IsNullOrWhiteSpace($accessToken)) {
            return [ordered]@{
                agent = 'claude'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Claude Code is not logged in with an OAuth account. Run claude auth login first.'
                windows = @()
            }
        }

        $headers = @{
            Authorization = "Bearer $accessToken"
            'anthropic-beta' = 'oauth-2025-04-20'
            'anthropic-version' = '2023-06-01'
            Accept = 'application/json'
            'User-Agent' = 'agent-delegation-tools/1.0.0'
        }

        try {
            $response = Invoke-RestMethod -Uri 'https://api.anthropic.com/api/oauth/usage' `
                -Headers $headers `
                -Method Get `
                -TimeoutSec $TimeoutSeconds
            $rawJson = $response | ConvertTo-Json -Depth 10
            return Parse-ClaudeUsageResponse -RawJson $rawJson -ObservedAt $observedAt
        }
        catch [System.Net.WebException] {
            if ($_.Exception.Response) {
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
                    $errBody = $reader.ReadToEnd()
                    if ($errBody -match '^{\s*"') {
                        return Parse-ClaudeUsageResponse -RawJson $errBody -ObservedAt $observedAt
                    }
                } catch { }
            }
            $httpStatus = if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { " (HTTP $([int]$_.Exception.Response.StatusCode))" } else { '' }
            return [ordered]@{
                agent = 'claude'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = "Claude usage query failed$($httpStatus): $($_.Exception.Message)"
                windows = @()
            }
        }
    }
    catch {
        return [ordered]@{
            agent = 'claude'
            availability = 'unavailable'
            observedAt = $observedAt.ToString('o')
            message = $_.Exception.Message
            windows = @()
        }
    }
}

function Parse-AgyUsageResponse {
    param(
        [Parameter(Mandatory = $true)][string]$RawJson,
        [Parameter(Mandatory = $true)][DateTimeOffset]$ObservedAt
    )

    $json = $RawJson | ConvertFrom-Json
    if ($null -ne $json.error) {
        $msg = if ($json.error.message) { $json.error.message } else { [string]$json.error }
        return [ordered]@{
            agent = 'agy'
            availability = 'unavailable'
            observedAt = $ObservedAt.ToString('o')
            message = "Antigravity usage query failed: $msg"
            windows = @()
        }
    }

    $configs = $json.clientModelConfigs
    if ($null -eq $configs -or @($configs).Count -eq 0) {
        return [ordered]@{
            agent = 'agy'
            availability = 'unavailable'
            observedAt = $ObservedAt.ToString('o')
            message = 'Antigravity returned no clientModelConfigs.'
            windows = @()
        }
    }

    $windows = New-Object 'Collections.Generic.List[object]'
    $seenPools = New-Object System.Collections.Generic.HashSet[string]

    foreach ($config in @($configs)) {
        if ($null -eq $config.quotaInfo) { continue }
        $label = if ($config.label) { [string]$config.label } else { '' }

        $poolName = if ($label -match '(?i)Gemini') {
            'agy (Gemini)'
        } elseif ($label -match '(?i)(Claude|GPT)') {
            'agy (Claude / GPT)'
        } else {
            "agy ($label)"
        }

        if ($seenPools.Contains($poolName)) { continue }
        $seenPools.Add($poolName) | Out-Null

        $remFraction = 1.0
        if ($null -ne $config.quotaInfo.remainingFraction) {
            $remFraction = [Math]::Max(0.0, [Math]::Min(1.0, [double]$config.quotaInfo.remainingFraction))
        }
        $remainingPercent = [int][Math]::Round($remFraction * 100.0)
        $usedPercent = 100 - $remainingPercent

        $resetIso = if ($config.quotaInfo.resetTime) { [string]$config.quotaInfo.resetTime } else { $null }
        $resetUnix = if ($resetIso) {
            try { [DateTimeOffset]::Parse($resetIso).ToUnixTimeSeconds() } catch { $null }
        } else { $null }

        $windows.Add([ordered]@{
            name = $poolName
            usedPercent = $usedPercent
            remainingPercent = $remainingPercent
            windowDurationMins = $null
            resetsAt = $resetIso
            resetsAtUnix = $resetUnix
        })
    }

    if ($windows.Count -eq 0) {
        return [ordered]@{
            agent = 'agy'
            availability = 'unavailable'
            observedAt = $ObservedAt.ToString('o')
            message = 'Antigravity responded but returned no quotaInfo in clientModelConfigs.'
            windows = @()
        }
    }

    return [ordered]@{
        agent = 'agy'
        availability = 'available'
        observedAt = $ObservedAt.ToString('o')
        message = 'Read from Antigravity LanguageServerService GetCascadeModelConfigData RPC.'
        windows = [object[]]($windows | ForEach-Object { $_ })
    }
}

function Get-AgyStatus {
    param(
        [int]$TimeoutSeconds = 15
    )

    $observedAt = [DateTimeOffset]::Now

    if ($env:FAKE_AGY_STATUS_RESPONSE) {
        return Parse-AgyUsageResponse -RawJson $env:FAKE_AGY_STATUS_RESPONSE -ObservedAt $observedAt
    }

    try {
        $lsProcesses = Get-Process -Name 'language_server' -ErrorAction SilentlyContinue
        if (-not $lsProcesses -or $lsProcesses.Count -eq 0) {
            return [ordered]@{
                agent = 'agy'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Antigravity is not running. Launch Antigravity to read real-time quota.'
                windows = @()
            }
        }

        $csrfToken = $null
        $candidatePorts = New-Object System.Collections.Generic.List[int]

        # Fast-path: scan log files for listening port and CSRF token (saves 1-2s over WMI/CIM)
        $logCandidates = @(
            (Join-Path $env:APPDATA 'Antigravity\logs\language_server.log'),
            (Join-Path $env:APPDATA 'Antigravity IDE\logs\language_server.log'),
            (Join-Path $env:USERPROFILE '.gemini\antigravity\logs\language_server.log')
        )
        foreach ($logPath in $logCandidates) {
            if (Test-Path -LiteralPath $logPath -PathType Leaf) {
                try {
                    $lines = Get-Content -LiteralPath $logPath -Tail 200 -ErrorAction SilentlyContinue
                    foreach ($line in $lines) {
                        if ($line -match 'listening on \w+ port at (\d+) for HTTPS') {
                            $p = [int]$Matches[1]
                            if (-not $candidatePorts.Contains($p)) { $candidatePorts.Add($p) }
                        }
                        if (-not $csrfToken -and $line -match '--csrf_token[=\s]+([^\s]+)') {
                            $csrfToken = $Matches[1]
                        }
                    }
                } catch { }
            }
        }

        # Fallback: query WMI / CIM if token was not in logs
        if (-not $csrfToken) {
            foreach ($proc in $lsProcesses) {
                $cmdLine = $null
                try {
                    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
                    if ($cim -and $cim.CommandLine) { $cmdLine = $cim.CommandLine }
                } catch { }
                if (-not $cmdLine) {
                    try {
                        $wmi = Get-WmiObject Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
                        if ($wmi -and $wmi.CommandLine) { $cmdLine = $wmi.CommandLine }
                    } catch { }
                }
                if (-not $cmdLine) {
                    try {
                        if ($proc.CommandLine) { $cmdLine = $proc.CommandLine }
                    } catch { }
                }
                if ($cmdLine -and $cmdLine -match '--csrf_token\s+([^\s]+)') {
                    $csrfToken = $Matches[1]
                    try {
                        $netConns = Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue
                        foreach ($conn in $netConns) {
                            $p = [int]$conn.LocalPort
                            if (-not $candidatePorts.Contains($p)) { $candidatePorts.Add($p) }
                        }
                    } catch { }
                    break
                }
            }
        }

        if (-not $csrfToken) {
            return [ordered]@{
                agent = 'agy'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Unable to retrieve Antigravity CSRF token from language_server.'
                windows = @()
            }
        }


        if ($candidatePorts.Count -eq 0) {
            return [ordered]@{
                agent = 'agy'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Unable to detect Antigravity Language Server listening port.'
                windows = @()
            }
        }

        $prevCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

        $responseObj = $null
        try {
            $headers = @{ 'x-codeium-csrf-token' = $csrfToken }
            $callTimeout = [Math]::Min($TimeoutSeconds, 5)
            foreach ($port in $candidatePorts) {
                try {
                    $url = "https://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData"
                    $responseObj = Invoke-RestMethod -Uri $url `
                        -Method Post `
                        -Body '{}' `
                        -ContentType 'application/json' `
                        -Headers $headers `
                        -TimeoutSec $callTimeout
                    if ($responseObj) { break }
                } catch { }
            }
        }
        finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCallback
        }

        if (-not $responseObj) {
            return [ordered]@{
                agent = 'agy'
                availability = 'unavailable'
                observedAt = $observedAt.ToString('o')
                message = 'Failed to connect to Antigravity Language Server RPC endpoint.'
                windows = @()
            }
        }

        $rawJson = $responseObj | ConvertTo-Json -Depth 10
        return Parse-AgyUsageResponse -RawJson $rawJson -ObservedAt $observedAt
    }
    catch {
        return [ordered]@{
            agent = 'agy'
            availability = 'unavailable'
            observedAt = $observedAt.ToString('o')
            message = $_.Exception.Message
            windows = @()
        }
    }
}

if (-not $WorkDir) { $WorkDir = (Get-Location).ProviderPath }
$resolvedWorkDir = Resolve-ExistingDirectory $WorkDir
$resolvedOutFile = if ($OutFile) { Resolve-OutputPath $OutFile } else { $null }
$statuses = New-Object 'Collections.Generic.List[object]'

if ($Agent -in @('all', 'codex')) {
    try {
        $resolvedCodex = Resolve-CodexExecutable $CodexPath
        $statuses.Add((Get-CodexStatus -Executable $resolvedCodex -Directory $resolvedWorkDir))
    }
    catch {
        $statuses.Add([ordered]@{
            agent = 'codex'
            availability = 'unavailable'
            observedAt = [DateTimeOffset]::Now.ToString('o')
            message = $_.Exception.Message
            windows = @()
        })
    }
}
if ($Agent -in @('all', 'agy')) {
    $statuses.Add((Get-AgyStatus -TimeoutSeconds $TimeoutSec))
}
if ($Agent -in @('all', 'claude')) {
    $statuses.Add((Get-ClaudeStatus -TimeoutSeconds $TimeoutSec))
}

$payload = if ($Agent -eq 'all') { [object[]]($statuses | ForEach-Object { $_ }) } else { $statuses[0] }
if ($Json) {
    $rendered = $payload | ConvertTo-Json -Depth 8
}
else {
    $lines = foreach ($status in $statuses) {
        if ($status.availability -eq 'available') {
            foreach ($window in @($status.windows)) {
                $reset = if ($window.resetsAt) { "; resets $($window.resetsAt)" } else { '' }
                "$($status.agent) $($window.name): $($window.remainingPercent)% remaining ($($window.usedPercent)% used)$reset"
            }
        }
        else {
            "$($status.agent): $($status.availability) - $($status.message)"
        }
    }
    $rendered = $lines -join [Environment]::NewLine
}

if ($resolvedOutFile) { [IO.File]::WriteAllText($resolvedOutFile, $rendered, $utf8NoBom) }
Write-Output $rendered
