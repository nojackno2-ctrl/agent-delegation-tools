---
name: agent-delegation-tools
description: Exact command lines for this machine's Windows delegation wrappers (delegate.ps1, codex.ps1, agy.ps1, claude.ps1) that run Codex CLI, an isolated Antigravity CLI agy process, or Claude Code as independent worker processes. Use when the user explicitly asks Antigravity/AGY to delegate, hand off, or run an independent external worker; when a task benefits from a specialized backend (Codex for heavy multi-file implementation, a separate AGY process for standalone tasks, Claude for review); or when non-ASCII Windows paths need sandbox junction handling. Do not trigger for ordinary coding work that Antigravity can perform directly, and do not confuse this with the internal invoke_subagent tool.
---

# Agent Delegation Tools (Antigravity)

Delegate clearly scoped tasks to isolated CLI worker processes (Codex, AGY, or Claude) on Windows.
Keep the parent agent responsible for scoping, reviewing diffs, verifying output, and delivering the
final answer.

## Choose the Subagent Backend

| Backend | Script | Recommended Scenarios | Default Model / Pricing |
|---|---|---|---|
| **Antigravity CLI (AGY)** | `agy.ps1` | Large context reading, fast scaffolding, architecture analysis, planning | `gemini-3.6-flash-low` (Google / lowest token cost) |
| **Codex CLI** | `codex.ps1` | Complex multi-file implementation, heavy refactoring, non-ASCII path worktrees | `gpt-5.6-sol` (OpenAI / ChatGPT quota) |
| **Claude Code** | `claude.ps1` | Deep reasoning, codebase exploration, review; resumable multi-turn workers | `sonnet` / `opus` (Anthropic quota) |
| **Unified Dispatcher** | `delegate.ps1` | Auto-routes: `analysis`/`scaffolding` → AGY, `review` → Claude, `implementation` → Codex | Automatically selects optimal worker |

Use `read-only` (Codex) or `plan` mode (AGY, Claude) for analysis and review. Ask for write access
only when implementation is authorized. Run one external worker at a time.

## Invocation for Antigravity

The wrappers live in the delegation checkout. Resolve it by absolute path first so this works from any
project, and fall back to this skill's own bundled copies if the checkout is unavailable:

```powershell
$repoRoot = 'C:\離線儲存\程式設計\子代理'
$wrapperRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot 'delegate.ps1')) {
    $repoRoot
} else {
    Join-Path $env:USERPROFILE '.agents\skills\agent-delegation-tools\scripts'
}

# Option 1: Unified Dispatcher
$delegateScript = Join-Path $wrapperRoot 'delegate.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $delegateScript -Agent codex -Sandbox workspace-write -OutFile "$env:TEMP\worker-result.txt" 'Implement feature X in src/core.ts.'

# Option 2: Direct Codex Worker (with non-ASCII path junction support)
$codexScript = Join-Path $wrapperRoot 'codex.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexScript -Sandbox workspace-write -OutFile "$env:TEMP\codex-result.txt" 'Implement the requested parser fix.'

# Option 3: Direct Antigravity CLI Worker (a second, isolated AGY process)
$agyScript = Join-Path $wrapperRoot 'agy.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agyScript -Mode plan -Model gemini-3.6-flash-low -OutFile "$env:TEMP\agy-result.txt" 'Analyze project dependencies and architecture.'

# Option 4: Direct Claude Code Worker (isolated context, resumable)
$claudeScript = Join-Path $wrapperRoot 'claude.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $claudeScript -OutFile "$env:TEMP\claude-result.txt" -RawFile "$env:TEMP\claude-result.json" 'Review src/api.ts for edge cases and security issues.'
```

A `claude.ps1` worker defaults to `-Mode plan` (reads, never writes) and `-Context isolated`
(`--safe-mode`: no plugins, skills, hooks, MCP servers, or `CLAUDE.md`). It prints a session id that a
follow-up run can `-Resume`. Exit codes: `0` success, `124` timeout, `10` Anthropic usage limit - on
`10`, switch backend or wait for the reset rather than configuring an API key. Full option table:
`skills/agent-delegation-tools/SKILL.md` in the checkout, Option D.

**Target directory**: every wrapper defaults `-WorkDir` to the current working directory, not to the
delegation checkout. When working in some other project that default is already correct - but pass
`-WorkDir <absolute path>` explicitly whenever the worker must act somewhere other than the cwd.

## Review the Result

1. Read output files using UTF-8 encoding (`Get-Content $outFile -Encoding UTF8`).
2. Directly inspect Git status and `git diff` yourself; do not accept the worker's summary as proof of success.
3. Run proportionate test verification on any modified files.
4. Update `AI_HANDOFF.md` with findings, progress, and verification results.

## Antigravity Guardrails

- **Distinct from internal subagents**: This skill delegates work to external, isolated CLI processes (`codex.ps1`, `agy.ps1`, `claude.ps1`), whereas `invoke_subagent` spawns internal subagents within Antigravity.
- **Prevent recursive delegation**: Never instruct an external worker process to invoke another layer of delegation. `claude.ps1` enforces this itself through `CLAUDE_DELEGATION_DEPTH`.
- **Execution policy**: Always use `-NoProfile -ExecutionPolicy Bypass` when executing PowerShell scripts via `run_command` without altering system-wide or user-wide execution policies.
