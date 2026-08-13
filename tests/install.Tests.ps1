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
    $roots = @{
        Codex = Join-Path $testRoot 'codex\skills'
        Antigravity = Join-Path $testRoot 'agents\skills'
        Claude = Join-Path $testRoot 'claude\skills'
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
        -Target All `
        -CodexSkillsRoot $roots.Codex `
        -AntigravitySkillsRoot $roots.Antigravity `
        -ClaudeSkillsRoot $roots.Claude | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Initial install failed with exit code $LASTEXITCODE." }

    foreach ($root in $roots.Values) {
        $destination = Join-Path $root 'agent-delegation-tools'
        foreach ($sourceFile in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
            $relativePath = $sourceFile.FullName.Substring($source.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
            $installedFile = Join-Path $destination $relativePath
            Assert-True (Test-Path -LiteralPath $installedFile -PathType Leaf) "Missing installed file: $installedFile"
            Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash -eq
                (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFile).Hash) "Hash mismatch: $installedFile"
        }
    }

    $staleSkill = Join-Path $roots.Claude 'agent-delegation-tools\SKILL.md'
    [IO.File]::WriteAllText($staleSkill, 'stale', (New-Object Text.UTF8Encoding($false)))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
        -Target Claude `
        -CodexSkillsRoot $roots.Codex `
        -AntigravitySkillsRoot $roots.Antigravity `
        -ClaudeSkillsRoot $roots.Claude | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Update install failed with exit code $LASTEXITCODE." }
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'SKILL.md')).Hash -eq
        (Get-FileHash -Algorithm SHA256 -LiteralPath $staleSkill).Hash) 'Update did not replace a stale installed file.'

    'install.Tests.ps1: all tests passed.'
}
finally {
    if ($testRoot.StartsWith($safeTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
