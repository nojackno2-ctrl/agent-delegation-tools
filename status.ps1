# Compatibility entry point. The installable skill owns the implementation.
$ErrorActionPreference = 'Stop'
$delegationScript = Join-Path $PSScriptRoot 'skills\agent-delegation-tools\scripts\status.ps1'
if (-not (Test-Path -LiteralPath $delegationScript -PathType Leaf)) {
    throw "Agent delegation status script is missing: $delegationScript"
}

try {
    & $delegationScript @args
    # status.ps1 returns structured unavailable records for provider/query errors;
    # a successful wrapper invocation itself must not inherit the app-server child
    # process's termination code.
    $delegationExitCode = 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
exit $delegationExitCode
