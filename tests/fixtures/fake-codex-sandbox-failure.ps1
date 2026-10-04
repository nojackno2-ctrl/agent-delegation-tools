param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$Arguments
)

# Login succeeds, but execution emits a startup failure and misleadingly exits zero.
if ($Arguments.Count -ge 2 -and [string]$Arguments[0] -eq 'login' -and [string]$Arguments[1] -eq 'status') {
    [Console]::Out.Write('Logged in')
    exit 0
}
$message = $env:FAKE_SANDBOX_FAILURE_TEXT
if (-not $message) {
    $message = 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors'
}
if ($env:FAKE_SANDBOX_FAILURE_STREAM -eq 'stderr') {
    [Console]::Error.Write($message)
}
else {
    [Console]::Out.Write($message)
}
exit 0
