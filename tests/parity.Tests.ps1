# Parity test: asserts parity between mcp-server TypeScript constants and PowerShell wrappers,
$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultsPath = Join-Path $repoRoot 'mcp-server\src\core\defaults.ts'
$typesPath = Join-Path $repoRoot 'mcp-server\src\core\types.ts'

Assert-True (Test-Path -LiteralPath $defaultsPath -PathType Leaf) "Missing $defaultsPath"
Assert-True (Test-Path -LiteralPath $typesPath -PathType Leaf) "Missing $typesPath"

# 1. Parse DEFAULT_MODELS from defaults.ts
$defaultsContent = [IO.File]::ReadAllText($defaultsPath, [Text.Encoding]::UTF8)
$expectedModels = @{}

if ($defaultsContent -match "agy:\s*\{\s*model:\s*'([^']+)',\s*effort:\s*'([^']+)'") {
    $expectedModels['agy'] = @{ Model = $matches[1]; Effort = $matches[2] }
} else { throw "Failed to parse agy model defaults from $defaultsPath" }

if ($defaultsContent -match "codex:\s*\{\s*model:\s*'([^']+)',\s*effort:\s*'([^']+)'") {
    $expectedModels['codex'] = @{ Model = $matches[1]; Effort = $matches[2] }
} else { throw "Failed to parse codex model defaults from $defaultsPath" }

if ($defaultsContent -match "claude:\s*\{\s*model:\s*'([^']+)',\s*effort:\s*'([^']+)'") {
    $expectedModels['claude'] = @{ Model = $matches[1]; Effort = $matches[2] }
} else { throw "Failed to parse claude model defaults from $defaultsPath" }

# 2. Parse EXIT_CODES from types.ts
$typesContent = [IO.File]::ReadAllText($typesPath, [Text.Encoding]::UTF8)
$expectedExitCodes = @{}
if ($typesContent -match '(?s)export const EXIT_CODES = \{(.*?)\}') {
    $exitCodesBlock = $matches[1]
    foreach ($line in ($exitCodesBlock -split "`n")) {
        if ($line -match '([A-Z_]+):\s*(\d+)') {
            $expectedExitCodes[$matches[1]] = [int]$matches[2]
        }
    }
} else { throw "Failed to parse EXIT_CODES from $typesPath" }

Assert-Equal 1 $expectedExitCodes['GENERIC_FAILURE'] 'EXIT_CODES.GENERIC_FAILURE must be 1'
Assert-Equal 0 $expectedExitCodes['SUCCESS'] 'EXIT_CODES.SUCCESS must be 0'
Assert-Equal 10 $expectedExitCodes['QUOTA_EXCEEDED'] 'EXIT_CODES.QUOTA_EXCEEDED must be 10'
Assert-Equal 75 $expectedExitCodes['ALL_DEPLETED'] 'EXIT_CODES.ALL_DEPLETED must be 75'
Assert-Equal 78 $expectedExitCodes['CONFIG_AUTH_ERROR'] 'EXIT_CODES.CONFIG_AUTH_ERROR must be 78'
Assert-Equal 79 $expectedExitCodes['ENVIRONMENT_FAILURE'] 'EXIT_CODES.ENVIRONMENT_FAILURE must be 79'
Assert-Equal 124 $expectedExitCodes['TIMEOUT'] 'EXIT_CODES.TIMEOUT must be 124'
Assert-Equal 130 $expectedExitCodes['CANCELLED'] 'EXIT_CODES.CANCELLED must be 130'

# 3. Assert PowerShell wrappers declare the aligned exit codes
$scriptNames = @('agy.ps1', 'claude.ps1', 'codex.ps1', 'delegate.ps1', 'parallel.ps1', 'status.ps1')
$canonicalDir = Join-Path $repoRoot 'skills\agent-delegation-tools\scripts'

foreach ($scriptName in $scriptNames) {
    $scriptPath = Join-Path $canonicalDir $scriptName
    $content = [IO.File]::ReadAllText($scriptPath, [Text.Encoding]::UTF8)

    Assert-True ($content -match '\$EXIT_SUCCESS\s*=\s*0\b') "$scriptName must define `$EXIT_SUCCESS = 0"
    Assert-True ($content -match '\$EXIT_GENERIC_FAILURE\s*=\s*1\b') "$scriptName must define `$EXIT_GENERIC_FAILURE = 1"
    Assert-True ($content -match '\$EXIT_QUOTA_EXCEEDED\s*=\s*10\b') "$scriptName must define `$EXIT_QUOTA_EXCEEDED = 10"
    Assert-True ($content -match '\$EXIT_ALL_DEPLETED\s*=\s*75\b') "$scriptName must define `$EXIT_ALL_DEPLETED = 75"
    Assert-True ($content -match '\$EXIT_CONFIG_AUTH_ERROR\s*=\s*78\b') "$scriptName must define `$EXIT_CONFIG_AUTH_ERROR = 78"
    Assert-True ($content -match '\$EXIT_ENVIRONMENT_FAILURE\s*=\s*79\b') "$scriptName must define `$EXIT_ENVIRONMENT_FAILURE = 79"
    Assert-True ($content -match '\$EXIT_TIMEOUT\s*=\s*124\b') "$scriptName must define `$EXIT_TIMEOUT = 124"
    Assert-True ($content -match '\$EXIT_CANCELLED\s*=\s*130\b') "$scriptName must define `$EXIT_CANCELLED = 130"
}

# 4. Assert default models and reasoning efforts match in delegate.ps1 dispatcher
$delegateContent = [IO.File]::ReadAllText((Join-Path $canonicalDir 'delegate.ps1'), [Text.Encoding]::UTF8)
Assert-True ($delegateContent -match ("agy\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['agy'].Model))) "delegate.ps1 agy default Model mismatch."
Assert-True ($delegateContent -match ("codex\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['codex'].Model))) "delegate.ps1 codex default Model mismatch."
Assert-True ($delegateContent -match ("claude\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['claude'].Model))) "delegate.ps1 claude default Model mismatch."

Assert-True ($delegateContent -match ("agy\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['agy'].Effort))) "delegate.ps1 agy default Effort mismatch."
Assert-True ($delegateContent -match ("codex\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['codex'].Effort))) "delegate.ps1 codex default Effort mismatch."
Assert-True ($delegateContent -match ("claude\s*=\s*'{0}'" -f [regex]::Escape($expectedModels['claude'].Effort))) "delegate.ps1 claude default Effort mismatch."

# agy.ps1 effort default when model is passed without effort
$agyContent = [IO.File]::ReadAllText((Join-Path $canonicalDir 'agy.ps1'), [Text.Encoding]::UTF8)
Assert-True ($agyContent -match '\$effectiveEffort\s*=\s*''medium''') "agy.ps1 effort fallback must be 'medium'."

'parity.Tests.ps1: all tests passed.'
