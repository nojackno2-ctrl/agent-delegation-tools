---
name: agent-delegation-tools
description: Inspect supported CLI usage limits and delegate bounded tasks to isolated Antigravity CLI, Codex CLI, or Claude CLI children on Windows, with parent-selected child model and reasoning effort, hard timeouts, concurrent batches, synchronization summaries, and optional sequential fallback when a CLI quota is exhausted. Use when the user asks for external CLI workers, parallel subagents, handoff, delegation, remaining Codex usage or reset time, cross-CLI quota fallback, or safe non-ASCII Codex CLI paths. Do not use for ordinary work the current agent can complete directly.
---

# Agent Delegation Tools

Delegate clearly scoped work to external CLI processes. Use direct wrappers or `delegate.ps1` for one task; use `parallel.ps1` for an explicitly partitioned batch that runs concurrently and joins at a synchronization barrier. The parent remains responsible for scope, model/effort choice, diff review, integration, verification, and the final response.

## Prepare

1. Read `AGENTS.md` and `AI_HANDOFF.md` in the target project when present.
2. Inspect the current branch, status, and relevant diff before delegation.
3. Define one bounded objective, allowed files, constraints, and one verification command.
4. Forbid Git mutations unless the user explicitly authorized them.
5. Use read-only analysis by default; implementation and scaffolding tasks automatically use `workspace-write` unless the parent explicitly selects another sandbox.
6. Preserve an explicit user choice of child model or reasoning effort. Validate it against the selected provider, but do not silently replace it.
7. When the user leaves either setting open, choose it from task complexity and provider support; omitting the corresponding CLI option deliberately uses that provider's configured default. These options change the child only, never the parent model or effort.
8. Before adding a different provider to `-FallbackAgent`, ensure the task may be transmitted to that provider.
9. Set a realistic wall-clock timeout. A timeout can leave partial work in the shared worktree; inspect it before retrying another provider.
10. Before parallel work, split the objective into independent tasks. Give every write task explicit, non-overlapping file or directory ownership and put dependent work in a later batch.

## Resolve the installed scripts

The repository `install.ps1` synchronizes the same package into Codex, Antigravity, and Claude skill directories. Resolve any installed copy whose scripts are present:

```powershell
$delegationCandidates = @()
if ($env:CODEX_HOME) {
    $delegationCandidates += Join-Path $env:CODEX_HOME 'skills\agent-delegation-tools'
}
$delegationCandidates += @(
    (Join-Path $env:USERPROFILE '.codex\skills\agent-delegation-tools'),
    (Join-Path $env:USERPROFILE '.agents\skills\agent-delegation-tools'),
    (Join-Path $env:USERPROFILE '.claude\skills\agent-delegation-tools')
)
$delegationRoot = $delegationCandidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'scripts\delegate.ps1') -PathType Leaf } |
    Select-Object -First 1
if (-not $delegationRoot) { throw 'agent-delegation-tools is not installed.' }
$delegationScripts = Join-Path $delegationRoot 'scripts'
```

Run wrappers through a per-process execution-policy override; do not change the machine or user policy.

## Inspect usage before delegation

Use `status.ps1` when provider choice depends on remaining usage or reset time:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'status.ps1') `
    -Agent all -Json -OutFile "$env:TEMP\delegation-status.json"
```

Codex status comes from the read-only app-server `account/rateLimits/read` method and does not start a model turn. Treat AGY and Claude as `unsupported` unless their current CLIs add an authoritative machine-readable usage interface. Never estimate remaining quota from schedules, elapsed time, UI labels, or past failures. An unavailable query is not proof of exhaustion.

## Choose child settings and backend

| Requested worker | Script | Safe analysis mode | Authorized write mode |
|---|---|---|---|
| Antigravity CLI / AGY | `agy.ps1` | `-Mode plan` | `-Mode workspace-write` |
| Codex CLI | `codex.ps1` | `-Sandbox read-only` | `-Sandbox workspace-write` |
| Claude CLI | `claude.ps1` | `-Mode plan` | `-Mode workspace-write` |
| Task-based routing | `delegate.ps1` | `analysis`/`review` default to `read-only` | `implementation`/`scaffolding` default to `workspace-write` |
| Concurrent batch and join | `parallel.ps1` | independent read-only tasks | each write task requires non-overlapping `writeScope` values |

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
    -Ephemeral -TimeoutSec 900 -OutFile "$env:TEMP\codex-worker.txt" `
    'Inspect the parser failure. Report the cause with file evidence. Do not edit files.'
```

Use `-AddDir` for extra workspaces. The wrapper gives non-ASCII paths collision-safe ASCII junctions. `-ApproveForMe` is optional and requires `workspace-write`; if the installed CLI rejects that version-sensitive combination, rerun without it and report the compatibility failure.

### Claude CLI worker

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'claude.ps1') `
    -WorkDir 'C:\path\to\project' -Mode plan -Context isolated `
    -Model '<claude-model>' -Effort high -OutFile "$env:TEMP\claude-worker.txt" `
    'Review the API for edge cases. Report file evidence. Do not edit files.'
```

The wrapper sends the prompt through UTF-8 stdin, disables prompt suggestions, avoids session persistence, and enforces `-TimeoutSec`. Keep `-Context isolated` unless project skills, hooks, or configuration are required. Use `-PersistSession` only when later continuation is part of the task.

### Unified dispatcher

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'delegate.ps1') `
    -Agent codex -FallbackAgent claude,agy -WorkDir 'C:\path\to\project' `
    -TimeoutSec 900 `
    -CodexModel '<codex-model>' -CodexEffort xhigh `
    -ClaudeModel '<claude-model>' -ClaudeEffort high `
    -AgyModel '<agy-model>' -AgyEffort high -OutFile "$env:TEMP\worker.txt" `
    'Review the changed API surface. Do not edit files.'
```

Automatic primary routing remains `analysis`/`scaffolding` to AGY, `review` to Claude, and `implementation` to Codex. `-FallbackAgent` is an ordered, opt-in list chosen by the parent; without it, only the primary child runs. Provider-specific model/effort values apply to their named child. The backward-compatible `-Model`/`-Effort` pair applies only to the primary child when no provider-specific value overrides it.

When `-Sandbox` is omitted, `delegate.ps1` derives it from `-TaskType`: `analysis` and `review` are read-only; `implementation` and `scaffolding` are workspace-write. This applies consistently when the dispatcher is launched from Codex, Antigravity, or Claude.

Selection precedence is: explicit user-provided provider setting, explicit user-provided primary `-Model`/`-Effort`, then the parent's automatic choice. Materialize a parent choice through the same provider-specific parameters; do not hard-code a model catalog in the dispatcher because provider catalogs and account availability change. If the parent intentionally wants the provider default, omit that setting.

The dispatcher recognizes quota exhaustion from nonzero CLI failures such as quota/usage-limit exhaustion, rate limiting, resource exhaustion, insufficient credits, and HTTP 429. It also recognizes Claude JSON envelopes with `is_error=true` and the same evidence. It does not switch on ordinary errors or timeouts. A fallback receives the original task, the current worktree, and bounded prior output marked as untrusted progress notes. If every candidate is exhausted, the dispatcher exits `75`; a wall-clock timeout exits `124` and preserves captured partial output. Inspect the worktree before any retry.

For an explicitly authorized headless AGY write run through the dispatcher, add `-Sandbox workspace-write -AgySkipPermissions`. Never use that switch for analysis or infer its authorization from a request to inspect code.

Every direct wrapper checks authentication before starting a child when the provider exposes a status command. If Codex or Claude is not logged in, the wrapper exits `78`, writes an actionable login command (`codex login` or `claude auth login`), and does not launch the task. AGY has no authoritative status subcommand in the current CLI; its wrapper detects authentication failures from the CLI response, exits `78`, and tells the user to run `agy` interactively and sign in. Authentication failures are terminal and are never mistaken for quota exhaustion or silently routed to another provider.

### Concurrent batch with synchronization barrier

Create a UTF-8 JSON task file. Each object accepts the dispatcher settings plus `name`, `prompt`, optional `taskTimeoutSec`, and `writeScope`. The following two implementation tasks may run together because their write scopes do not overlap:

```json
[
  {
    "name": "api-tests",
    "prompt": "Implement and test the API parser only. Do not commit or push.",
    "agent": "codex",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "writeScope": ["src/api", "tests/api"],
    "codexEffort": "high"
  },
  {
    "name": "docs-review",
    "prompt": "Update only the operator documentation. Do not commit or push.",
    "agent": "claude",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "writeScope": ["docs"],
    "claudeEffort": "high"
  }
]
```

Run the batch into a new or empty results directory:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'parallel.ps1') `
    -TaskFile 'C:\path\to\tasks.json' `
    -ResultsDir "$env:TEMP\delegation-results" `
    -WorkDir 'C:\path\to\project' `
    -MaxConcurrency 2 -ChildTimeoutSec 900 -TaskTimeoutSec 1800 -Json
```

`parallel.ps1` launches at most `MaxConcurrency` independent dispatcher processes, waits until every task finishes or times out, and writes one `summary.json` plus isolated `final.txt`, `raw.txt`, `stdout.txt`, `stderr.txt`, and `result.json` files per task. It rejects duplicate task names, `danger-full-access`, missing write scopes, overlapping write scopes, non-empty result directories, and recursive delegation. A task-level timeout terminates only that task's process tree. Aggregate exit is `0` when all tasks succeed, `124` when any task times out, and `1` for other mixed failures; each task's original exit code remains in the summary.

Workers do not message each other directly. The shared synchronization point is the completed summary and current worktree. For dependencies, run multiple explicit waves: parallel discovery, parent synthesis, then a later implementation or review batch. Never schedule tasks that must read another task's in-flight edits in the same wave.

## Review

1. Read output files as UTF-8.
2. Inspect status and diff directly; never treat a worker summary as proof.
3. Run proportionate verification yourself.
4. Update `AI_HANDOFF.md` after material results or failed attempts.
5. Identify child-created temporary or untracked artifacts from `git status`; remove only artifacts proven to belong to the run.
6. Report real exit codes, timeouts, denied permissions, and unverified behavior plainly.

All entry points reject recursive external delegation through `AGENT_DELEGATION_DEPTH`. Do not bypass that guard. Quota fallback inside one task remains sequential; only `parallel.ps1` may fan out independent tasks under the parent-selected concurrency limit.
