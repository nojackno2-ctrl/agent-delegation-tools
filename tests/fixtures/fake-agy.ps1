param(
    [string]$p,

    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$recordedArguments = @('-p', $p) + @($Arguments)
[IO.File]::WriteAllLines($env:FAKE_AGY_ARGS_FILE, [string[]]$recordedArguments, $utf8NoBom)
if ($env:FAKE_AGY_CWD_FILE) {
    [IO.File]::WriteAllText($env:FAKE_AGY_CWD_FILE, (Get-Location).ProviderPath, $utf8NoBom)
}
if ($env:FAKE_AGY_DEPTH_FILE) {
    [IO.File]::WriteAllText($env:FAKE_AGY_DEPTH_FILE, [string]$env:AGENT_DELEGATION_DEPTH, $utf8NoBom)
}
if ($env:FAKE_AGY_SLEEP_MS) {
    Start-Sleep -Milliseconds ([int]$env:FAKE_AGY_SLEEP_MS)
}
if ($null -ne $env:FAKE_AGY_OUTPUT) {
    [Console]::Out.Write($env:FAKE_AGY_OUTPUT)
}
exit [int]$env:FAKE_AGY_EXIT_CODE
