$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repositoryRoot 'skills\agent-delegation-tools\scripts\status.ps1'
$compatibilityScript = Join-Path $repositoryRoot 'status.ps1'
$fakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex-app-server.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("agent-delegation-status-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $argsFile = Join-Path $testRoot 'args.txt'
    $inputFile = Join-Path $testRoot 'initialize.txt'
    $outFile = Join-Path $testRoot 'status.json'
    $reset = [DateTimeOffset]::Now.AddHours(2).ToUnixTimeSeconds()
    $env:FAKE_CODEX_STATUS_ARGS_FILE = $argsFile
    $env:FAKE_CODEX_STATUS_INPUT_FILE = $inputFile
    $env:FAKE_CODEX_STATUS_RESPONSE = '{"id":1,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":7,"windowDurationMins":300,"resetsAt":' + $reset + '},"secondary":{"usedPercent":35,"windowDurationMins":10080,"resetsAt":' + ($reset + 3600) + '}}}}}'

    $rendered = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script `
        -Agent all -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 5 -OutFile $outFile -Json
    Assert-Equal 0 $LASTEXITCODE 'Usage-status helper should complete successfully.'
    $parsedStatuses = ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) | ConvertFrom-Json
    $statuses = @($parsedStatuses | ForEach-Object { $_ })
    Assert-Equal 3 $statuses.Count 'All-provider status should return Codex, AGY, and Claude.'
    $codex = $statuses | Where-Object agent -eq 'codex'
    Assert-Equal 'available' $codex.availability 'Codex usage should be marked available.'
    Assert-Equal 93 $codex.windows[0].remainingPercent 'Codex remaining percentage was not derived correctly.'
    Assert-Equal $reset $codex.windows[0].resetsAtUnix 'Codex reset timestamp was not preserved.'
    Assert-Equal 'unsupported' (($statuses | Where-Object agent -eq 'agy').availability) 'AGY must be explicit about unsupported usage queries.'
    Assert-Equal 'unsupported' (($statuses | Where-Object agent -eq 'claude').availability) 'Claude must be explicit about unsupported usage queries.'
    Assert-True (([IO.File]::ReadAllText($inputFile, [Text.Encoding]::UTF8)).StartsWith('{"method":"initialize"')) 'The app-server handshake must start with initialize and no UTF-8 BOM.'
    $arguments = [IO.File]::ReadAllLines($argsFile, [Text.Encoding]::UTF8)
    Assert-True ($arguments -contains 'app-server') 'Status helper did not launch Codex app-server.'
    Assert-True ($arguments -contains 'stdio://') 'Status helper did not use the stdio transport.'

    $rootJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $compatibilityScript `
        -Agent codex -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 5 -Json
    Assert-Equal 0 $LASTEXITCODE 'Root status forwarder should succeed.'
    Assert-Equal 'available' (($rootJson -join [Environment]::NewLine | ConvertFrom-Json).availability) 'Root status forwarder changed the result.'

    $env:FAKE_CODEX_STATUS_SLEEP_MS = '3000'
    $timeoutJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script `
        -Agent codex -CodexPath $fakeCodex -WorkDir $testRoot -TimeoutSec 1 -Json
    Assert-Equal 0 $LASTEXITCODE 'A status timeout should return structured unavailability, not crash.'
    $timeoutStatus = $timeoutJson -join [Environment]::NewLine | ConvertFrom-Json
    Assert-Equal 'unavailable' $timeoutStatus.availability 'Timed-out Codex usage should be marked unavailable.'
    Assert-True ($timeoutStatus.message -match 'Timed out') 'Timed-out Codex usage should preserve timeout evidence.'

    'status.Tests.ps1: all tests passed.'
}
finally {
    foreach ($name in @('FAKE_CODEX_STATUS_ARGS_FILE','FAKE_CODEX_STATUS_INPUT_FILE','FAKE_CODEX_STATUS_RESPONSE','FAKE_CODEX_STATUS_SLEEP_MS')) {
        Remove-Item -LiteralPath ("Env:$name") -ErrorAction SilentlyContinue
    }
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
