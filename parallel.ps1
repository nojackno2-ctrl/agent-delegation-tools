# Compatibility entry point. The installable skill owns the implementation.
$ErrorActionPreference = 'Stop'
$parallelScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\parallel.ps1'
if (-not (Test-Path -LiteralPath $parallelScript -PathType Leaf)) {
    throw "Agent parallel delegation script is missing: $parallelScript"
}

try {
    & $parallelScript @args
    $parallelExitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
exit $parallelExitCode
