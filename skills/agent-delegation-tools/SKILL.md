---
name: agent-delegation-tools
description: Delegate one bounded task to an isolated Antigravity CLI, Codex CLI, or Claude CLI child on Windows, with parent-selected child model and reasoning effort plus optional sequential fallback when a CLI quota is exhausted. Use when the user asks for an external CLI worker, handoff, delegation, cross-CLI quota fallback, or safe non-ASCII Codex CLI paths. Do not use for ordinary work the current agent can complete directly.
---

# Agent Delegation Tools

Delegate one clearly scoped task to one external CLI process at a time. The parent may explicitly order fallback CLIs, but the dispatcher tries them sequentially and only after a recognized quota/usage-limit failure. Keep the parent responsible for scope, model/effort choice, diff review, verification, and the final response.

## Prepare

1. Read `AGENTS.md` and `AI_HANDOFF.md` in the target project when present.
2. Inspect the current branch, status, and relevant diff before delegation.
3. Define one bounded objective, allowed files, constraints, and one verification command.
4. Forbid Git mutations unless the user explicitly authorized them.
5. Use read-only analysis by default; enable writes only for authorized implementation.
6. Choose the child model and reasoning effort from task complexity and provider support. These options change the child only, never the parent model or effort.
7. Before adding a different provider to `-FallbackAgent`, ensure the task may be transmitted to that provider.

## Resolve the installed scripts

The repository `install.ps1` synchronizes the same package into the Codex, Antigravity, Claude Code, and VS Code Copilot skill directories. Resolve any installed copy whose scripts are present:

```powershell
$delegationCandidates = @()
if ($env:CODEX_HOME) {
    $delegationCandidates += Join-Path $env:CODEX_HOME 'skills\agent-delegation-tools'
}
if ($env:COPILOT_HOME) {
    $delegationCandidates += Join-Path $env:COPILOT_HOME 'skills\agent-delegation-tools'
}
$delegationCandidates += @(
    (Join-Path $env:USERPROFILE '.codex\skills\agent-delegation-tools'),
    (Join-Path $env:USERPROFILE '.agents\skills\agent-delegation-tools'),
    (Join-Path $env:USERPROFILE '.claude\skills\agent-delegation-tools'),
    (Join-Path $env:USERPROFILE '.copilot\skills\agent-delegation-tools')
)
$delegationRoot = $delegationCandidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'scripts\delegate.ps1') -PathType Leaf } |
    Select-Object -First 1
if (-not $delegationRoot) { throw 'agent-delegation-tools is not installed.' }
$delegationScripts = Join-Path $delegationRoot 'scripts'
```

Run wrappers through a per-process execution-policy override; do not change the machine or user policy.

## Choose child settings and backend

| Requested worker | Script | Safe analysis mode | Authorized write mode |
|---|---|---|---|
| Antigravity CLI / AGY | `agy.ps1` | `-Mode plan` | `-Mode workspace-write` |
| Codex CLI | `codex.ps1` | `-Sandbox read-only` | `-Sandbox workspace-write` |
| Claude CLI | `claude.ps1` | `-Mode plan` | `-Mode workspace-write` |
| Task-based routing | `delegate.ps1` | default `analysis` + `read-only` | pass `-TaskType implementation -Sandbox workspace-write` |

When the user asks a host to use its matching CLI as a subagent, call the matching direct wrapper. Pass `-Model` and `-Effort` when the parent judges an override useful. Use the dispatcher when task-based routing or quota fallback is useful.

### Antigravity CLI worker

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'agy.ps1') `
    -WorkDir 'C:\path\to\project' -Mode plan -Model '<agy-model>' -Effort high `
    -OutFile "$env:TEMP\agy-worker.txt" `
    'Inspect the dependency flow. Report file evidence. Do not edit files.'
```

Use `-AddDir` for additional workspaces. Use `-SkipPermissions` only with an explicit write mode. AGY enforces `-PrintTimeout` itself.

### Codex CLI worker

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'codex.ps1') `
    -WorkDir 'C:\path\to\project' -Sandbox read-only -Model '<codex-model>' -Effort xhigh `
    -Ephemeral -OutFile "$env:TEMP\codex-worker.txt" `
    'Inspect the parser failure. Report the cause with file evidence. Do not edit files.'
```

Use `-AddDir` for extra workspaces. The wrapper gives non-ASCII paths collision-safe ASCII junctions. Use `-ApproveForMe` only with `workspace-write`.

### Claude CLI worker

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'claude.ps1') `
    -WorkDir 'C:\path\to\project' -Mode plan -Context isolated `
    -Model '<claude-model>' -Effort high -OutFile "$env:TEMP\claude-worker.txt" `
    'Review the API for edge cases. Report file evidence. Do not edit files.'
```

The wrapper sends the prompt through UTF-8 stdin and enforces `-TimeoutSec`. Keep `-Context isolated` unless project skills, hooks, or configuration are required.

### Unified dispatcher

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'delegate.ps1') `
    -Agent codex -FallbackAgent claude,agy -WorkDir 'C:\path\to\project' `
    -CodexModel '<codex-model>' -CodexEffort xhigh `
    -ClaudeModel '<claude-model>' -ClaudeEffort high `
    -AgyModel '<agy-model>' -AgyEffort high -OutFile "$env:TEMP\worker.txt" `
    'Review the changed API surface. Do not edit files.'
```

Automatic primary routing remains `analysis`/`scaffolding` to AGY, `review` to Claude, and `implementation` to Codex. `-FallbackAgent` is an ordered, opt-in list chosen by the parent; without it, only the primary child runs. Provider-specific model/effort values apply to their named child. The backward-compatible `-Model`/`-Effort` pair applies only to the primary child when no provider-specific value overrides it.

The dispatcher recognizes quota exhaustion from nonzero CLI failures such as quota/usage-limit exhaustion, rate limiting, resource exhaustion, insufficient credits, and HTTP 429. It also recognizes Claude JSON envelopes with `is_error=true` and the same evidence. It does not switch on ordinary errors. A fallback receives the original task, the current worktree, and bounded prior output marked as untrusted progress notes. If every candidate is exhausted, the dispatcher exits `75`.

## Review

1. Read output files as UTF-8.
2. Inspect status and diff directly; never treat a worker summary as proof.
3. Run proportionate verification yourself.
4. Update `AI_HANDOFF.md` after material results or failed attempts.
5. Report real exit codes, timeouts, denied permissions, and unverified behavior plainly.

All wrappers reject recursive external delegation through `AGENT_DELEGATION_DEPTH`. Do not bypass that guard or fan out multiple external workers; quota fallback remains sequential.
