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

    # 5. Test -Uninstall -DryRun
    $uninstallDryRun = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All -Uninstall -DryRun
    if ($LASTEXITCODE -ne 0) { throw "Uninstall -DryRun failed with exit code $LASTEXITCODE." }
    Assert-True (($uninstallDryRun -join [Environment]::NewLine).Contains('uninstall dry run')) 'Uninstall -DryRun output did not mention dry run mode.'
    Assert-True (Test-Path -LiteralPath $destinations[0] -PathType Container) 'Uninstall -DryRun must not delete skill directories.'

    # 6. Test -Uninstall -WhatIf
    $uninstallWhatIf = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All -Uninstall -WhatIf
    if ($LASTEXITCODE -ne 0) { throw "Uninstall -WhatIf failed with exit code $LASTEXITCODE." }
    Assert-True (Test-Path -LiteralPath $destinations[0] -PathType Container) 'Uninstall -WhatIf must not delete skill directories.'

    # 7. Test -Uninstall -All
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All -Uninstall | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Uninstall -All failed with exit code $LASTEXITCODE." }
    foreach ($dest in $destinations) {
        Assert-True (-not (Test-Path -LiteralPath $dest)) "Uninstall -All did not remove $dest."
    }

    # 8. Test npm failure path with fake npm on PATH
    # Reinstall skills first
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All | Out-Null
    $fakeBin = Join-Path $testRoot 'fake-bin'
    New-Item -ItemType Directory -Path $fakeBin | Out-Null
    $fakeNpmCmd = Join-Path $fakeBin 'npm.cmd'
    [IO.File]::WriteAllText($fakeNpmCmd, "@echo off`r`necho simulated npm error >&2`r`nexit /b 1`r`n", [Text.Encoding]::ASCII)
    $originalPath = $env:PATH
    try {
        $env:PATH = "$fakeBin;$originalPath"
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $npmFailOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -All -Mcp 2>&1)
            $npmExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $prevEap
        }
        Assert-True ($npmExitCode -ne 0) 'install.ps1 -Mcp must fail with non-zero exit code when npm fails.'
        Assert-True (($npmFailOutput -join [Environment]::NewLine).Contains('npm run install:mcp failed')) 'install.ps1 should output clear error message on npm failure.'
    }
    finally {
        $env:PATH = $originalPath
    }

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
