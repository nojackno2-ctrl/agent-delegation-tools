---
name: agent-delegation-tools
description: Delegate bounded tasks to isolated CLI workers (Codex CLI, Antigravity CLI agy, Claude Code) on Windows through bundled wrappers (delegate.ps1, codex.ps1, agy.ps1, claude.ps1). Use when the user explicitly asks to delegate, hand off, or run an independent subagent worker; when a task benefits from a specialized external backend (e.g. Codex for multi-file refactoring, AGY Flash for large-context scaffolding/analysis, Claude for deep review); or when non-ASCII Windows paths need sandbox junction handling. Do not trigger for ordinary coding work that the primary agent can perform directly.
---

# Agent Delegation Tools (Multi-Backend Subagents)

Delegate one clearly scoped task to an isolated CLI subagent process on Windows. Keep the parent agent responsible for scoping, reviewing diffs, verifying output, and delivering the final answer.

## 1. Choose the Subagent Backend

| Backend | Script | Recommended Scenarios | Default Model / Pricing |
|---|---|---|---|
| **Antigravity CLI (AGY)** | `agy.ps1` | Large context reading, fast scaffolding, architecture analysis, planning | `gemini-3.6-flash-low` (Google / lowest token cost) |
| **Codex CLI** | `codex.ps1` | Complex multi-file implementation, heavy refactoring, non-ASCII path worktrees | `gpt-5.6-sol` (OpenAI / ChatGPT quota) |
| **Claude Code** | `claude.ps1` | Deep reasoning, codebase exploration, review; resumable multi-turn workers | `sonnet` / `opus` (Anthropic quota) |
| **Unified Dispatcher** | `delegate.ps1` | Auto-routes by task type: `analysis`/`scaffolding` → AGY, `review` → Claude, `implementation` → Codex | Automatically selects optimal worker |

### Selection Rules:
- **Default to native tools** when the parent agent can complete the task directly without external delegation.
- **Run only one external subagent at a time**. Do not perform unbounded fan-out or recursive subagent nesting.
- **Use `read-only` (or `plan` mode)** for analysis, investigation, or code review. Use `workspace-write` (or `accept-edits` mode) only when implementation is authorized.

---

## 2. Prepare the Task

1. Inspect `AGENTS.md`, `AI_HANDOFF.md`, Git status, and relevant diffs before delegating.
2. Formulate one bounded objective with clear file targets, architectural constraints, and verification requirements.
3. Explicitly forbid the subagent from performing Git mutations (`git commit`, `git push`, `git reset`, `git rebase`, branch deletion) unless requested by the user.

---

## 3. Invoke the Subagent

Resolve the wrappers once. The delegation checkout is the source of truth; a globally installed copy
of this skill falls back to the scripts bundled beside it:

```powershell
$repoRoot = 'C:\離線儲存\程式設計\子代理'
$wrapperRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot 'delegate.ps1')) {
    $repoRoot
} else {
    Join-Path $PSScriptRoot 'scripts'   # installed skill: <skill dir>\scripts\
}
```

Every wrapper defaults `-WorkDir` to the current working directory, not to the checkout. Pass
`-WorkDir <absolute path>` explicitly whenever the worker must act somewhere other than the cwd.

### Option A: Unified Dispatcher (`delegate.ps1`)

Auto-route based on task type:
```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $wrapperRoot 'delegate.ps1') -TaskType analysis -OutFile "$env:TEMP\worker-result.txt" 'Analyze the authentication flow in src/auth.ts. Do not edit files.'
```

### Option B: Antigravity CLI Worker (`agy.ps1`)

For fast planning or large-context scaffolding:
```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $wrapperRoot 'agy.ps1') -Mode plan -Model gemini-3.6-flash-low -OutFile "$env:TEMP\agy-result.txt" 'Analyze data flow between worker and storage modules. Report findings with file references.'
```

### Option C: Codex CLI Worker (`codex.ps1`)

For dedicated multi-file code implementation (with automated Windows junction handling for non-ASCII paths):
```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $wrapperRoot 'codex.ps1') -Sandbox workspace-write -OutFile "$env:TEMP\codex-result.txt" 'Implement the requested parser enhancements. Preserve existing comments. Run tests and report results.'
```

### Option D: Claude Code Worker (`claude.ps1`)

For independent deep review. Defaults are already worker-shaped: `plan` permission mode (reads,
never writes), an isolated context, a json result envelope, and a 900 s timeout.

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $wrapperRoot 'claude.ps1') -OutFile "$env:TEMP\claude-result.txt" 'Review src/api.ts for potential edge cases and security vulnerabilities.'
```

Let the worker write, and give it the one command it needs to verify its own work:
```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $wrapperRoot 'claude.ps1') -Mode acceptEdits -AllowedTools 'Bash(npm test)' -OutFile "$env:TEMP\claude-result.txt" 'Fix the failing parser test in src/lexer.js, then run npm test and report the output.'
```

Key options:

| Option | Effect |
|---|---|
| `-Mode` | `plan` (default) / `acceptEdits` / `bypassPermissions` / `dontAsk` / `auto` / `manual`. Also accepts `read-only`, `workspace-write`, `danger-full-access` so `delegate.ps1` can forward `-Sandbox` unchanged. |
| `-Context` | `isolated` (default) runs `--safe-mode`: no plugins, skills, hooks, MCP servers, or `CLAUDE.md`. Measured on this repository: ~48.7k prompt tokens without it vs ~7.0k with it, and ~3.6k once `-Tools` is narrowed. Use `project` only when the worker needs the project's own configuration. |
| `-Tools`, `-AllowedTools`, `-DisallowedTools` | Narrow the built-in tool set / allow specific calls (`'Bash(npm test)'`) / deny specific calls. |
| `-OutFile`, `-RawFile` | Final assistant message (UTF-8, no BOM), and the raw json envelope for `session_id` / `total_cost_usd` / `permission_denials`. |
| `-Resume <id>`, `-SessionId <uuid>`, `-ForkSession` | Multi-turn delegation. Every run prints its session id, so a follow-up task continues the same worker instead of re-sending the whole briefing. |
| `-Model`, `-FallbackModel`, `-Effort`, `-MaxBudgetUsd` | Model tier, overload fallback list, reasoning effort, and a spend ceiling. |
| `-AddDir`, `-AppendSystemPrompt`, `-WorkDir` | Extra readable directories, an extra system-prompt paragraph, and the worker's cwd. |
| `-TimeoutSec` (default 900), `-DryRun` | Hard wall-clock limit — `claude` has no `--print-timeout` of its own. `-DryRun` prints the resolved command line without calling the CLI. |

Exit codes: `0` success, `124` timeout (worker killed), `10` Anthropic usage limit — on `10`, switch
backend or wait for the reset; never configure an API key as a fallback. The wrapper also refuses to
run inside an already-delegated worker (`CLAUDE_DELEGATION_DEPTH`) unless `-AllowNested` is passed.

---

## 4. Review the Result

1. Read output files using UTF-8 encoding (`Get-Content $outFile -Encoding UTF8`).
2. Directly inspect Git status and `git diff` yourself; do not accept the worker's summary as proof of success.
3. Run proportionate test verification on any modified files.
4. Update `AI_HANDOFF.md` with findings, progress, and verification results.
5. Report the actual verified results to the user plainly.
