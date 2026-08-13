param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$OutFile,
    [string]$RawFile,
    [string]$WorkDir,
    [int]$TimeoutSec,
    [string]$Agent,
    [string]$TaskType,
    [string]$Sandbox
)

$ErrorActionPreference = 'Stop'
$jsonPrompt = ([string]$Prompt -split '\r?\n\r?\n', 2)[-1]
$spec = $jsonPrompt | ConvertFrom-Json
$utf8NoBom = New-Object Text.UTF8Encoding($false)

if ($spec.expectedSandbox -and [string]$spec.expectedSandbox -ne $Sandbox) {
    [Console]::Error.Write("expected sandbox '$($spec.expectedSandbox)', received '$Sandbox'")
    exit 89
}

if ($spec.name -and $env:FAKE_PARALLEL_BARRIER_DIR) {
    $marker = Join-Path $env:FAKE_PARALLEL_BARRIER_DIR ("$($spec.name).started")
    [IO.File]::WriteAllText($marker, [DateTimeOffset]::UtcNow.ToString('o'), $utf8NoBom)
}

if ($spec.waitFor -and $env:FAKE_PARALLEL_BARRIER_DIR) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(3)
    do {
        $missing = @($spec.waitFor | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $env:FAKE_PARALLEL_BARRIER_DIR ("$_.started")) -PathType Leaf)
        })
        if ($missing.Count -eq 0) { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($missing.Count -gt 0) {
        [Console]::Error.Write("barrier timeout waiting for: $($missing -join ',')")
        exit 88
    }
}

if ($spec.sleepMs) { Start-Sleep -Milliseconds ([int]$spec.sleepMs) }
if ($OutFile) { [IO.File]::WriteAllText($OutFile, "result:$($spec.name)", $utf8NoBom) }
if ($RawFile) { [IO.File]::WriteAllText($RawFile, "raw:$($spec.name)", $utf8NoBom) }
[Console]::Out.Write("stdout:$($spec.name)")
if ($spec.stderr) { [Console]::Error.Write([string]$spec.stderr) }
exit $(if ($null -ne $spec.exitCode) { [int]$spec.exitCode } else { 0 })
