# Runs Antigravity CLI (agy) non-interactively as an isolated subagent worker.
#
# Usage:
#   .\agy.ps1 "Analyze architecture in src/core"
#   .\agy.ps1 -Mode plan "Plan the database migration"
#   .\agy.ps1 -Model gemini-3.1-pro-low -Effort high "Review complex crypto logic"
#   .\agy.ps1 -OutFile result.txt "Scaffold unit tests for auth module"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    [ValidateSet('accept-edits', 'plan')]
    [string]$Mode = 'accept-edits',

    # Default to cost-effective fast model; override with pro / claude / gpt-oss as needed.
    [string]$Model = 'gemini-3.6-flash-low',

    [ValidateSet('low', 'medium', 'high')]
    [string]$Effort,

    [string]$WorkDir,

    # Capture the agent's output into a file with UTF-8 encoding.
    [string]$OutFile,

    [ValidateSet('text', 'json', 'stream-json')]
    [string]$OutputFormat = 'text',

    # Auto-approve tool permissions for automated non-interactive tasks.
    [switch]$SkipPermissions,

    # Enable terminal restrictions sandbox.
    [switch]$Sandbox,

    [string]$PrintTimeout = '5m'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Locate agy.exe
$agyBin = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (-not (Test-Path -LiteralPath $agyBin)) {
    $cmd = Get-Command 'agy.exe' -ErrorAction SilentlyContinue
    if ($cmd) {
        $agyBin = $cmd.Source
    } else {
        throw "Antigravity CLI (agy.exe) is not found in $agyBin or on PATH."
    }
}

# Resolve target working directory
$originalLocation = (Get-Location).Path
if (-not $WorkDir) {
    $targetDir = $originalLocation
} else {
    $targetDir = (Resolve-Path -LiteralPath $WorkDir).Path
}

# Build arguments for agy
$agyArgs = @('-p', $Prompt, '--mode', $Mode, '--model', $Model, '--output-format', $OutputFormat, '--print-timeout', $PrintTimeout)
if ($Effort) {
    $agyArgs += @('--effort', $Effort)
}
if ($SkipPermissions) {
    $agyArgs += '--dangerously-skip-permissions'
}
if ($Sandbox) {
    $agyArgs += '--sandbox'
}

try {
    if ($targetDir -ne $originalLocation) {
        Set-Location -LiteralPath $targetDir
    }

    if ($OutFile) {
        $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
        $output = $null | & $agyBin @agyArgs 2>&1
        $exitCode = $LASTEXITCODE
        [IO.File]::WriteAllLines($outPath, $output, [Text.Encoding]::UTF8)
        $output | ForEach-Object { Write-Host $_ }
    } else {
        $null | & $agyBin @agyArgs
        $exitCode = $LASTEXITCODE
    }
} finally {
    if ((Get-Location).Path -ne $originalLocation) {
        Set-Location -LiteralPath $originalLocation
    }
}

exit $exitCode
