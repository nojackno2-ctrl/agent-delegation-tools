---
name: agent-delegation-tools
description: Autonomous ambient subagent delegation and quota-aware load balancing across Antigravity CLI (AGY), Codex CLI, and Claude CLI on Windows. In Codex, discover and prefer the host agent_delegation MCP tools before PowerShell wrappers. Use actively for coding, multi-file implementation, research, testing, parallel batches, or quota management.
---

# Agent Delegation Tools

An always-on, passive subagent delegation and load-balancing framework on Windows. The parent agent acts as the coordinator/architect and autonomously delegates bounded tasks—especially heavy coding, file editing, multi-file refactoring, independent subtasks, research, and parallel execution—to Antigravity CLI, Codex CLI, or Claude CLI children with write permissions enabled. Only Codex enforces an OS workspace sandbox; AGY and Claude write modes skip prompts without filesystem confinement to work_dir.

## Core Behavioral Principles

1. **Passive / Ambient Delegation**:
   Do not wait for the user to explicitly request delegation or subagent creation. Whenever a task involves implementing features, editing code, multi-file refactoring, writing tests, exploring unfamiliar codebases, or executing independent subtasks, proactively partition the task and delegate execution to subagents.

2. **Live Quota-Aware Load Balancing**:
   Always inspect live subscription usage (`status.ps1 -Agent all -Json` or `delegate.ps1 -BalanceQuota`) before assigning work. If a provider's remaining quota is low (<= 10%), exhausted (0%), or unavailable (e.g. rate-limited HTTP 429), dynamically route the task to a healthy provider with abundant quota (e.g. AGY Gemini / Claude / GPT models) and configure healthy fallback providers. Never repeatedly push work to an exhausted CLI.

3. **Proactive Workspace Write Permissions**:
   When delegating coding, bug fixes, refactoring, or implementation tasks, grant full workspace write permissions (`workspace-write` / `accept-edits` with `-SkipPermissions` / `-AgySkipPermissions`) so subagents can directly modify files without being blocked on read-only constraints or terminal approval prompts.

4. **Parent Coordination & Verification**:
   The parent agent remains responsible for defining clear task bounds, setting child models/effort, reviewing git status and diffs after subagents complete, running verification/tests, and presenting synthesized results.

5. **External CLIs Carry the Load**:
   Route work to AGY and Codex. The Claude CLI child spends the *same* subscription quota as the parent agent, so it offloads context but not quota; use it only when the user asks for it by name, or when AGY and Codex are both depleted.

## Default child models

Unless the user names a different model, delegate with these and do not override them:

| Backend | Model | Effort |
|---|---|---|
| Antigravity (AGY) | `gemini-3.8-flash` | `medium` |
| Codex CLI | `gpt-6.1-sol` | `medium` |
| Claude CLI | `claude-sonnet-5-5` | `medium` |

The `agent-delegation` MCP server applies these same defaults automatically, so `delegate_task` / `invoke_*` calls need no model arguments. Prefer the MCP tools when they are connected; the PowerShell wrappers below are the fallback path.

## MCP-First Discovery & Tool Routing

1. **Early MCP Discovery**: In Codex and other MCP-enabled environments, first search deferred/lazy tools for all nine tools: `get_agent_quotas`, `delegate_task`, `delegate_parallel`, `invoke_agy`, `invoke_codex`, `invoke_claude`, `get_job_status`, `get_job_result`, `cancel_job` (including `ALL_TOOLS` / tool search when available).
2. **Single Canonical Namespace**: Use exactly one connected `agent_delegation` namespace (`[mcp_servers.agent_delegation]`). Never mix or duplicate with legacy hyphenated aliases.
3. **PowerShell Wrapper Fallback**: Only fall back to invoking the PowerShell wrappers (`delegate.ps1`, `status.ps1`, etc.) after tool search conclusively proves no host MCP server is connected.
4. **Codex Sandbox Diagnostic Warning**: Running `codex mcp list` inside `CodexSandboxOffline` reads the sandbox home (`~/.codex/config.toml` inside the sandbox environment) and cannot diagnose or inspect the parent Desktop host registry. Host MCP tools are bridged from the parent host environment; do not mistake sandbox CLI output for host MCP disconnection.

## Async MCP jobs and polling

- `delegate_task` and `delegate_parallel` default to `async=true` and return a `job_id` immediately. All delegation and `invoke_*` calls require `work_dir`: an absolute path to an existing directory.
- Poll `get_job_result` with that `job_id` and `wait_sec=25` (default). Each call can wait at most 50 seconds; use `0` for an immediate check. Repeat while status is `running`, until `succeeded`, `failed`, `timed_out`, or `cancelled`. A returned job ID is dispatch acknowledgement, not proof of success.
- `get_job_status` without `job_id` lists retained jobs; supply an ID for one job's summary. `cancel_job(job_id)` terminates the child process tree and reports cancellation (exit `130`).
- `invoke_agy`, `invoke_codex`, and `invoke_claude` default to synchronous execution (`async=false`). Set `async=true` for long work and use the same polling flow. `delegate_*` accepts `async=false` for synchronous waiting.
- Desktop MCP hosts enforce their own request timeout and ignore `MCP_TOOL_TIMEOUT`. Unlimited child execution (`timeout_sec=0`) cannot override the host timeout; dispatch and poll long work.
- Finished jobs are kept in memory for one hour, at most 50; running jobs do not expire. Server restart loses the in-memory registry. Results include `attempts` failover history. Long outputs are tail-truncated with a full log file path; inspect the history and log when diagnosing a failed or recovered attempt.

## Prepare

1. Read `AGENTS.md` and `AI_HANDOFF.md` in the target project when present.
2. Inspect the current branch, status, and relevant diff before delegation.
3. Check CLI quota availability with `status.ps1` or pass `-BalanceQuota` to route to a healthy provider.
4. Define one bounded objective, target files, constraints, and one verification command.
5. For implementation, bug fixing, refactoring, and code changes, configure **workspace-write** mode and skip-permission flags. Use read-only mode only for pure inspection or audit tasks.
6. Forbid Git mutations (commit, push, branch resets) unless the user explicitly authorized them.
7. Select child model and reasoning effort based on task complexity, provider support, and quota health.
8. Before parallel work, split the objective into independent tasks with non-overlapping `writeScope` paths.

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

PowerShell wrappers and the native TypeScript MCP server are deliberately retained as two front-ends. `tests/parity.Tests.ps1` enforces parity of default models and exit codes. PowerShell scripts live in `skills/agent-delegation-tools/scripts/`; the manifest is `skills/agent-delegation-tools/SKILL.md`. `install.ps1` copies this package into personal skill directories.

## Inspect usage before delegation

Use `status.ps1` when provider choice depends on remaining usage or reset time:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'status.ps1') `
    -Agent all -Json -OutFile "$env:TEMP\delegation-status.json"
```

`-Agent` selects `all` (default), `codex`, `agy`, or `claude`. `-TimeoutSec` bounds each query (default 15), `-WorkDir` sets the directory used for the Codex query, and `-CodexPath` overrides Codex executable discovery. Without `-Json` the script prints one readable line per usage window. No query starts a model turn.

- **Codex**: Read from Codex app-server stdio JSON-RPC `account/rateLimits/read` without starting a model turn.
- **Claude Code**: Read from Anthropic OAuth endpoint `https://api.anthropic.com/api/oauth/usage` using credentials in `~/.claude/.credentials.json` (or `$env:CLAUDE_CONFIG_DIR/.credentials.json`), extracting 5-hour and 7-day usage windows with reset timestamps.
- **Antigravity (AGY)**: Run the official `/usage` slash command through the logged-in host CLI and parse authoritative 7-day plus 5-hour windows for the Gemini and Claude/GPT pools. If `/usage` does not return a weekly window, treat AGY as unavailable for quota-aware routing; the Language Server `quotaInfo` fallback is short-window diagnostics only and must never be labeled as weekly quota.

When the parent runs under `CodexSandboxOffline`, invoke external CLIs and quota readers through the registered host-side `agent_delegation` MCP server. Do not copy `auth.json`, OAuth tokens, CSRF tokens, or provider credential files into the workspace or temp directory to make a direct sandbox child inherit host authentication.

### Quota-Aware Load Balancing Rule

- When a provider has `<= 10%` remaining quota or is in an `unavailable`/rate-limited state, **do not route new tasks to it**.
- Instead, route to the healthiest provider (e.g. AGY Gemini 3.8 Flash or AGY Claude / GPT) and specify fallback chains.
- Pass `-BalanceQuota` to `delegate.ps1` to perform automated quota balancing across backends.

## Choose child settings and backend

### Sandbox boundaries

Only Codex enforces an OS sandbox for `workspace-write`. AGY write modes use `--dangerously-skip-permissions`; Claude CLI write modes use `bypassPermissions`. These skip permission prompts and are **not confined to work_dir**. Treat work_dir as the starting directory, define explicit file scope, and review the actual diff. `read-only` maps to AGY plan mode, Claude plan mode, and Codex read-only; AGY/Claude plan modes are not OS filesystem isolation. `danger-full-access` removes the workspace sandbox boundary.

On Windows, Codex logs containing `helper_unknown_error: setup refresh had errors` and `write ACE failed ... open ACL target for update` can indicate that the repo folder is owned by another (orphaned) SID. This prevents sandbox ACL setup and has the same ownership cause as Git's `dubious ownership`. Fix ownership in an elevated terminal with `takeown /F <repo> /R /D Y`, replacing `<repo>` with the affected repo's absolute path, then retry. Increasing the timeout does not repair ACLs.

| Requested worker | Script | Implementation / File edit mode (Default for Coding) | Pure inspection mode |
|---|---|---|---|
| Antigravity CLI / AGY | `agy.ps1` | `-Mode workspace-write -SkipPermissions` | `-Mode plan` |
| Codex CLI | `codex.ps1` | `-Sandbox workspace-write` | `-Sandbox read-only` |
| Claude CLI | `claude.ps1` | `-Mode workspace-write` | `-Mode plan` |
| Quota-balanced routing | `delegate.ps1` | `-TaskType implementation -Sandbox workspace-write -BalanceQuota` | `-TaskType analysis` |
| Concurrent batch | `parallel.ps1` | `"sandbox": "workspace-write"` with partitioned `"writeScope"` | independent read-only tasks |

### Antigravity CLI worker (Implementation / File Modification)

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'agy.ps1') `
    -WorkDir 'C:\path\to\project' -Mode workspace-write -SkipPermissions `
    -Model 'gemini-3.8-flash' -Effort medium `
    -OutFile "$env:TEMP\agy-worker.txt" `
    'Implement the authentication middleware in src/auth.ts and update tests.'
```

Use `gemini-3.8-flash` (with `-Effort low|medium|high`, `gemini-3.8-flash-high`, or `gemini-3.8-flash-low`) for fast scaffolding, implementation, or deep reasoning plans. AGY also supports `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `gpt-oss-120b-medium`. Use `-SkipPermissions` with write modes so headless runs do not block on terminal prompts. AGY enforces `-PrintTimeout` itself; the default `0` waits until the turn completes.

### Codex CLI worker (Implementation / File Modification)

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'codex.ps1') `
    -WorkDir 'C:\path\to\project' -Sandbox workspace-write -Model 'gpt-6.1-sol' -Effort medium `
    -ApproveForMe -Ephemeral -OutFile "$env:TEMP\codex-worker.txt" `
    'Refactor the database repository in src/db.ts to use connection pooling.'
```

Use `-AddDir` for extra workspaces. The wrapper gives non-ASCII paths collision-safe ASCII junctions. It resolves the executable from `-CodexPath` or `CODEX_CLI_PATH`, then an explicit `CODEX_HOME`, then the newest Desktop-managed bundle that contains both `codex.exe` and its matching `codex-code-mode-host.exe`, then `~/.codex/.sandbox-bin`, and only then PATH. This keeps host-side MCP workers from selecting an incomplete sandbox-bin copy whose tool calls fail closed. `-ApproveForMe` is optional and requires `workspace-write`; current Codex CLI makes that flag imply the workspace-write sandbox, so the wrapper deliberately omits the incompatible duplicate `--sandbox workspace-write` argument.

### Claude CLI worker (Implementation / File Modification)

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'claude.ps1') `
    -WorkDir 'C:\path\to\project' -Mode workspace-write -Context isolated `
    -Model 'claude-sonnet-5-5' -Effort medium -OutFile "$env:TEMP\claude-worker.txt" `
    'Add input sanitization to src/routes.ts and verify error handling.'
```

The wrapper sends the prompt through UTF-8 stdin, disables prompt suggestions, avoids session persistence, and enforces `-TimeoutSec` only when one is given (default `0` = no limit). Keep `-Context isolated` unless project skills, hooks, or configuration are required.

### Unified dispatcher (with Quota-Aware Rebalance & Write Permissions)

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'delegate.ps1') `
    -TaskType implementation -Sandbox workspace-write -BalanceQuota `
    -WorkDir 'C:\path\to\project' `
    -AgyModel 'gemini-3.8-flash' -AgyEffort medium -CodexModel 'gpt-6.1-sol' -CodexEffort medium `
    -ClaudeModel 'claude-sonnet-5-5' -ClaudeEffort medium -OutFile "$env:TEMP\worker.txt" `
    'Implement the requested feature in src/service.ts and verify tests pass.'
```

`-BalanceQuota` automatically reads live quota health from `status.ps1`. If the default backend for the task type has low or exhausted quota, the dispatcher dynamically rebalances the task to the healthiest available provider and populates healthy fallback candidates.

Selection precedence is: explicit user-provided provider setting, explicit user-provided primary `-Model`/`-Effort`, then the parent's automatic choice.

The dispatcher recognizes quota exhaustion from nonzero CLI failures (such as quota/usage-limit exhaustion, rate limiting, resource exhaustion, insufficient credits, and HTTP 429) and Claude JSON error envelopes (`is_error=true`). A fallback receives the original task, current worktree, and bounded prior output. If every candidate is exhausted, the dispatcher exits `75`; a wall-clock timeout exits `124`.

### Concurrent batch with synchronization barrier

Create a UTF-8 JSON task file. Each object accepts dispatcher settings plus `name`, `prompt`, optional `taskTimeoutSec`, and `writeScope`:

```json
[
  {
    "name": "api-implementation",
    "prompt": "Implement and test the API parser in src/api. Do not commit or push.",
    "agent": "auto",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "balanceQuota": true,
    "writeScope": ["src/api", "tests/api"],
    "agyEffort": "medium"
  },
  {
    "name": "docs-update",
    "prompt": "Update the API reference documentation in docs. Do not commit or push.",
    "agent": "auto",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "balanceQuota": true,
    "writeScope": ["docs"],
    "agyEffort": "low"
  }
]
```

Run the batch into a new or empty results directory:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $delegationScripts 'parallel.ps1') `
    -TaskFile 'C:\path\to\tasks.json' `
    -ResultsDir "$env:TEMP\delegation-results" `
    -WorkDir 'C:\path\to\project' `
    -MaxConcurrency 2 -Json
```

`parallel.ps1` launches at most `MaxConcurrency` independent dispatcher processes, waits until every task finishes or times out, and writes one `summary.json` plus isolated `final.txt`, `raw.txt`, `stdout.txt`, `stderr.txt`, and `result.json` files per task. It rejects duplicate task names, `danger-full-access`, missing write scopes, overlapping write scopes, non-empty result directories, and recursive delegation. A task-level timeout terminates only that task's process tree. Aggregate exit is `0` when all tasks succeed, `124` when any task times out, and `1` for other mixed failures; each task's original exit code remains in the summary.

Workers do not message each other directly. The shared synchronization point is the completed summary and current worktree. For dependencies, run multiple explicit waves: parallel discovery, parent synthesis, then a later implementation or review batch. Never schedule tasks that must read another task's in-flight edits in the same wave.

## Exit codes

The single source of truth is `mcp-server/src/core/types.ts` (`EXIT_CODES`). Keep this table and README aligned with it; default models/effort are defined in `mcp-server/src/core/defaults.ts`.

| Code | Meaning | Handling |
|---|---|---|
| `0` | Success | Read results and verify changes. |
| `1` | Generic failure | Inspect stderr and full log. |
| `10` | Single provider quota exceeded | Dispatcher can fail over to a healthy provider. |
| `75` | All providers depleted / recursive delegation refused | Wait for quota reset or remove recursion; never bypass the depth guard. |
| `78` | Config/auth error | Correct configuration or sign in; not quota exhaustion. |
| `79` | Environment failure (e.g. Codex Windows sandbox setup failed) | Dispatcher fails over; inspect attempts and repair the environment. |
| `124` | Timeout | Child execution defaults to unlimited; explicit positive timeouts and quota-query deadlines remain enforced. |
| `130` | Cancelled | Child process tree is terminated. |

### Signed-out CLI recovery

`agy.ps1`, `codex.ps1`, and `claude.ps1` recognize a not-signed-in CLI in the child output, exit `78`, and append the sign-in command for that provider: `agy`, `codex login`, or `claude auth login`.

Exit `78` is a configuration failure, not quota exhaustion. The dispatcher does not fall back to another provider for it, and no delegated work was performed. Report it, ask the user to complete that CLI's interactive sign-in, then retry the same task. Do not substitute API-key credentials for a subscription sign-in unless the user asks for that.

## Review

1. Read output files as UTF-8.
2. Inspect status and diff directly; never treat a worker summary as proof.
3. Run proportionate verification yourself.
4. Update `AI_HANDOFF.md` after material results or failed attempts.
5. Identify child-created temporary or untracked artifacts from `git status`; remove only artifacts proven to belong to the run.
6. Report real exit codes, timeouts, denied permissions, and unverified behavior plainly.

All entry points reject recursive external delegation through `AGENT_DELEGATION_DEPTH`. Do not bypass that guard. Quota fallback inside one task remains sequential; only `parallel.ps1` may fan out independent tasks under the parent-selected concurrency limit.
