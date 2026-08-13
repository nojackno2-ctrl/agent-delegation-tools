param(
    [switch]$p,

    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
if (-not $p -and $Arguments.Count -ge 2 -and [string]$Arguments[0] -eq 'auth' -and [string]$Arguments[1] -eq 'status') {
    if ($env:FAKE_CLAUDE_LOGGED_IN -eq 'false') {
        [Console]::Out.Write('{"loggedIn":false}')
        exit 1
    }
    [Console]::Out.Write('{"loggedIn":true}')
    exit 0
}
$prompt = [Console]::In.ReadToEnd()
$recordedArguments = @()
if ($p) { $recordedArguments += '-p' }
$recordedArguments += @($Arguments)
[IO.File]::WriteAllLines($env:FAKE_CLAUDE_ARGS_FILE, [string[]]$recordedArguments, $utf8NoBom)
[IO.File]::WriteAllText($env:FAKE_CLAUDE_PROMPT_FILE, $prompt, $utf8NoBom)
if ($env:FAKE_CLAUDE_CWD_FILE) {
    [IO.File]::WriteAllText($env:FAKE_CLAUDE_CWD_FILE, (Get-Location).ProviderPath, $utf8NoBom)
}
if ($env:FAKE_CLAUDE_DEPTH_FILE) {
    [IO.File]::WriteAllText($env:FAKE_CLAUDE_DEPTH_FILE, [string]$env:AGENT_DELEGATION_DEPTH, $utf8NoBom)
}
if ($env:FAKE_CLAUDE_SLEEP_MS) {
    Start-Sleep -Milliseconds ([int]$env:FAKE_CLAUDE_SLEEP_MS)
}
if ($null -ne $env:FAKE_CLAUDE_OUTPUT) {
    [Console]::Out.Write($env:FAKE_CLAUDE_OUTPUT)
}
if ($env:FAKE_CLAUDE_ERROR) {
    [Console]::Error.Write($env:FAKE_CLAUDE_ERROR)
}
exit [int]$env:FAKE_CLAUDE_EXIT_CODE
