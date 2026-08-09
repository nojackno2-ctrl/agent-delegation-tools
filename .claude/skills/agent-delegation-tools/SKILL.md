---
name: agent-delegation-tools
description: Exact command lines for this machine's Windows delegation wrappers (delegate.ps1, codex.ps1, agy.ps1, claude.ps1) that run Codex CLI, Antigravity CLI agy, or Claude Code as isolated worker processes. Use once the decision to delegate to an external CLI has been made and the invocation details are needed - flags, sandbox and permission modes, session resume, output capture, timeouts, exit codes. For deciding whether to delegate at all and which backend to pick, use the agent-delegation skill instead. Do not trigger for ordinary coding work Claude Code can perform directly.
---

# Agent Delegation Tools (Claude Code)

Delegate clearly scoped tasks to isolated CLI worker processes (Codex, AGY, or Claude) on Windows.

This skill covers **how to invoke** the wrappers. Whether to delegate at all, which backend to pick,
and the quota rules are the `agent-delegation` skill's job - consult that first.

The full task-preparation, backend selection matrix, and review guidelines are canonical in
`skills/agent-delegation-tools/SKILL.md` inside the checkout resolved below.

## Invocation for Claude Code

The wrappers live in the delegation checkout. Resolve it by absolute path first so this works from any
project, and fall back to the current repository if the checkout has moved:

```powershell
$repoRoot = 'C:\離線儲存\程式設計\子代理'
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'delegate.ps1'))) {
    $repoRoot = (& git rev-parse --show-toplevel)
}

# Option 1: Unified Dispatcher
$delegateScript = Join-Path $repoRoot 'delegate.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $delegateScript -Agent codex -Sandbox workspace-write -OutFile "$env:TEMP\worker-result.txt" 'Implement feature X in src/core.ts.'

# Option 2: Direct Codex Worker (with non-ASCII path junction support)
$codexScript = Join-Path $repoRoot 'codex.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexScript -Sandbox workspace-write -OutFile "$env:TEMP\codex-result.txt" 'Implement the requested parser fix.'

# Option 3: Direct Antigravity Worker (isolated AGY process)
$agyScript = Join-Path $repoRoot 'agy.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agyScript -Mode plan -Model gemini-3.6-flash-low -OutFile "$env:TEMP\agy-result.txt" 'Analyze project dependencies and architecture.'

# Option 4: Direct Claude Code Worker (separate process, isolated context, resumable)
$claudeScript = Join-Path $repoRoot 'claude.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $claudeScript -OutFile "$env:TEMP\claude-result.txt" -RawFile "$env:TEMP\claude-result.json" 'Review src/api.ts for edge cases and security issues.'
```

A `claude.ps1` worker defaults to `-Mode plan` (reads, never writes) and `-Context isolated`
(`--safe-mode`: no plugins, skills, hooks, MCP servers, or `CLAUDE.md`). It prints a session id that a
follow-up run can `-Resume`. Full option table: `skills/agent-delegation-tools/SKILL.md`, Option D.

**Target directory**: every wrapper defaults `-WorkDir` to the current working directory, not to the
delegation checkout. When working in some other project, that default is already correct - but pass
`-WorkDir <absolute path>` explicitly whenever the worker must act somewhere other than the cwd.

## Claude Code Guardrails

- **Distinct from internal Claude subagents**: This skill delegates work to external, isolated CLI processes via `.ps1` wrappers rather than Claude Code's internal subagent tools. Prefer the internal Agent tool when the work only needs a fan-out inside this session; use `claude.ps1` when the worker must run in its own process, its own directory, or its own permission mode.
- **Prevent recursive delegation**: Never instruct an external worker process to invoke another layer of delegation. `claude.ps1` enforces this itself through `CLAUDE_DELEGATION_DEPTH`.
- **Execution policy**: Use `-NoProfile -ExecutionPolicy Bypass` when executing PowerShell scripts without modifying system-wide execution policies.
