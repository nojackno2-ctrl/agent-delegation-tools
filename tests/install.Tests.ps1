$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repositoryRoot 'install.ps1'
$source = Join-Path $repositoryRoot 'skills\agent-delegation-tools'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("agent-delegation-install-{0}" -f [Guid]::NewGuid().ToString('N'))))
$safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected test directory: $testRoot"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
$oldUserProfile = $env:USERPROFILE
$oldCodexHome = $env:CODEX_HOME
$oldCopilotHome = $env:COPILOT_HOME

try {
    $env:USERPROFILE = $testRoot
    Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:COPILOT_HOME -ErrorAction SilentlyContinue

    # 1. Test -All installation
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Initial install with -All failed with exit code $LASTEXITCODE." }

    $destinations = @(
        (Join-Path $testRoot '.codex\skills\agent-delegation-tools'),
        (Join-Path $testRoot '.agents\skills\agent-delegation-tools'),
        (Join-Path $testRoot '.claude\skills\agent-delegation-tools'),
        (Join-Path $testRoot '.copilot\skills\agent-delegation-tools')
    )

    foreach ($dest in $destinations) {
        foreach ($sourceFile in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
            $relativePath = $sourceFile.FullName.Substring($source.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
            $installedFile = Join-Path $dest $relativePath
            Assert-True (Test-Path -LiteralPath $installedFile -PathType Leaf) "Missing installed file: $installedFile"
            Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash -eq
                (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFile).Hash) "Hash mismatch: $installedFile"
        }
    }

    # 2. Test -Target claude update
    $staleSkill = Join-Path $testRoot '.claude\skills\agent-delegation-tools\SKILL.md'
    [IO.File]::WriteAllText($staleSkill, 'stale', (New-Object Text.UTF8Encoding($false)))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target claude | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Update install for Claude failed with exit code $LASTEXITCODE." }
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'SKILL.md')).Hash -eq
        (Get-FileHash -Algorithm SHA256 -LiteralPath $staleSkill).Hash) 'Update did not replace a stale installed file.'

    # 3. Test -Prune
    $extraFile = Join-Path $testRoot '.agents\skills\agent-delegation-tools\stale.txt'
    [IO.File]::WriteAllText($extraFile, 'stale', (New-Object Text.UTF8Encoding($false)))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target agents -Prune | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Prune install failed with exit code $LASTEXITCODE." }
    Assert-True (-not (Test-Path -LiteralPath $extraFile)) 'Prune did not remove the stale file.'

    # 4. Test -DryRun
    $dryRunOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All -DryRun
    if ($LASTEXITCODE -ne 0) { throw "DryRun failed with exit code $LASTEXITCODE." }
    Assert-True (($dryRunOutput -join [Environment]::NewLine).Contains('dry run')) 'DryRun output did not mention dry run mode.'

    'install.Tests.ps1: all tests passed.'
}
finally {
    $env:USERPROFILE = $oldUserProfile
    if ($null -ne $oldCodexHome) { $env:CODEX_HOME = $oldCodexHome }
    if ($null -ne $oldCopilotHome) { $env:COPILOT_HOME = $oldCopilotHome }
}
}
finally {
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
