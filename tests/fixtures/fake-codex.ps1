param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$Arguments
)

$ErrorActionPreference = 'Stop'
if ($Arguments.Count -ge 2 -and [string]$Arguments[0] -eq 'login' -and [string]$Arguments[1] -eq 'status') {
    if ($env:FAKE_CODEX_LOGGED_IN -eq 'false') {
        [Console]::Error.Write('Not logged in')
        exit 1
    }
    [Console]::Out.Write('Logged in')
    exit 0
}
[IO.File]::WriteAllLines($env:FAKE_CODEX_ARGS_FILE, [string[]]$Arguments, [Text.UTF8Encoding]::new($false))
if ($env:FAKE_CODEX_SLEEP_MS) {
    Start-Sleep -Milliseconds ([int]$env:FAKE_CODEX_SLEEP_MS)
}
if ($null -ne $env:FAKE_CODEX_OUTPUT) {
    [Console]::Out.Write($env:FAKE_CODEX_OUTPUT)
}
if ($env:FAKE_CODEX_ERROR) {
    [Console]::Error.Write($env:FAKE_CODEX_ERROR)
}
exit [int]$env:FAKE_CODEX_EXIT_CODE
