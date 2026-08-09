---
name: agent-delegation-tools
description: Delegate one bounded task to an isolated Codex CLI worker on Windows through the bundled codex.ps1 wrapper. Use when the user explicitly asks Codex to delegate, hand off, or run an independent Codex worker; when an external agent needs Codex implementation help; or when a non-ASCII Windows workspace path would otherwise break Codex CLI sandbox working-directory handling. Do not trigger for ordinary coding work that Codex can perform directly.
---

# Agent Delegation Tools

Delegate one clearly scoped task to one isolated Codex CLI process. Keep the parent agent responsible for scope, validation, and the final answer.

## Choose the execution path

- Prefer native Codex collaboration tools when they are available and the user requested subagents or parallel work.
- Use the bundled wrapper when the user explicitly wants an external Codex CLI worker, an external agent is delegating into Codex, or a non-ASCII Windows worktree needs the wrapper's junction handling.
- Never use this skill merely because a task involves editing files.
- Run only one external worker at a time. Do not let a delegated worker invoke this skill again.

## Prepare the task

1. Inspect `AGENTS.md`, `AI_HANDOFF.md`, Git status, and relevant diffs in the target worktree.
2. Give the worker one bounded objective, target files, constraints, and verification expectations.
3. Use `read-only` for investigation or review. Use `workspace-write` only when the user authorized implementation.
4. Preserve existing changes. Do not authorize commit, push, reset, rebase, branch deletion, or release actions unless the user explicitly requested them.

## Invoke the worker

Resolve the installed script from the Codex home directory:

```powershell
$delegationCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$delegationScript = Join-Path $delegationCodexHome 'skills\agent-delegation-tools\scripts\codex.ps1'
```

For analysis:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $delegationScript -WorkDir 'C:\path\to\project' -Sandbox read-only -OutFile "$env:TEMP\codex-worker-result.txt" 'Inspect the parser failure. Report the cause with file and line evidence. Do not edit files.'
```

For an authorized implementation:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $delegationScript -WorkDir 'C:\path\to\project' -Sandbox workspace-write -OutFile "$env:TEMP\codex-worker-result.txt" 'Implement the requested parser fix. Preserve unrelated changes. Run the focused tests and report exact results. Do not commit or push.'
```

Pass `-Model` or `-Effort` only when the user requests an override or the task requires one. Pass `-Json` only when machine-readable event output is needed. Use `-SkipGitCheck` only for a deliberately non-Git target.

Use the per-process execution-policy override shown above when local policy blocks `.ps1` files. Do not change the machine or user execution policy.

## Review the result

1. Read the final-message file as UTF-8.
2. Inspect the target worktree diff and status yourself; the worker's summary is not proof.
3. Run proportionate verification yourself when the worker changed files.
4. Update `AI_HANDOFF.md` after meaningful changes or failed attempts.
5. Report the worker's actual result and any unverified behavior plainly.
