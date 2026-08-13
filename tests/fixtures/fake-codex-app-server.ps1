param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if ($env:FAKE_CODEX_STATUS_ARGS_FILE) {
    [IO.File]::WriteAllLines($env:FAKE_CODEX_STATUS_ARGS_FILE, [string[]]$Arguments, $utf8NoBom)
}
if ($env:FAKE_CODEX_STATUS_SLEEP_MS) {
    Start-Sleep -Milliseconds ([int]$env:FAKE_CODEX_STATUS_SLEEP_MS)
}

$initialize = [Console]::In.ReadLine()
if ($env:FAKE_CODEX_STATUS_INPUT_FILE) {
    [IO.File]::WriteAllText($env:FAKE_CODEX_STATUS_INPUT_FILE, [string]$initialize, $utf8NoBom)
}
[Console]::Out.WriteLine('{"id":0,"result":{}}')
[Console]::Out.Flush()
$initialized = [Console]::In.ReadLine()
$query = [Console]::In.ReadLine()
[Console]::Out.WriteLine($env:FAKE_CODEX_STATUS_RESPONSE)
[Console]::Out.Flush()

while ([Console]::In.ReadLine() -ne $null) { }
