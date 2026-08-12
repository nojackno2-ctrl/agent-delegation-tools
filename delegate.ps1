# Compatibility entry point. The installable skill owns the implementation.
$ErrorActionPreference = 'Stop'
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\delegate.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Agent delegation script is missing: $delegationScript"
}

try {
    & $delegationScript @args
    $delegationExitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
exit $delegationExitCode
