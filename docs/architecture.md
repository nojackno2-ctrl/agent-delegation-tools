# Architecture and Front-End Parity

This document outlines the dual front-end architecture of **Agent Delegation Tools**, the shared model and exit-code contract, and the automated parity enforcement mechanism.

---

## 1. Dual Front-End Design

The repository deliberately maintains two independent front-ends for subagent delegation:

1. **Native TypeScript MCP Server (`mcp-server/`)**:
   - Implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) over standard I/O (stdio).
   - Designed for seamless, strongly-typed JSON-RPC integration with AI host applications (Claude Desktop, Google Antigravity / Gemini CLI, Codex CLI, Cursor, Windsurf, Zed, VS Code Copilot).
   - Operates 100% natively in Node.js/TypeScript without bridging through PowerShell.
   - Features in-memory TTL caching (10-second quota cache) and an asynchronous job management registry (`get_job_status`, `get_job_result`, `cancel_job`).

2. **Standalone PowerShell CLI Wrappers (`skills/agent-delegation-tools/scripts/`)**:
   - Designed for direct execution in Windows terminal sessions, interactive scripting, headless CI/CD, and environments without active MCP host connections.
   - Wraps external CLI binaries (`agy`, `codex`, `claude`) directly with argument translation, Windows UTF-8 console setup, NTFS ASCII junction handling, and quota queries.

Both front-ends are first-class citizens and must remain synchronized in behavior, default configurations, and exit codes.

---

## 2. Single Source of Truth & Parity Contract

To avoid configuration drift between the TypeScript MCP implementation and the PowerShell wrappers, single sources of truth are established:

### Default Models and Reasoning Effort
- **Source of Truth**: [`mcp-server/src/core/defaults.ts`](../mcp-server/src/core/defaults.ts) (`DEFAULT_MODELS`, `DEFAULT_SANDBOX`).
- Current canonical matrix:
  - **Antigravity (AGY)**: `gemini-3.8-flash`, effort `medium`
  - **OpenAI Codex CLI**: `gpt-6.1-sol`, effort `medium`
  - **Anthropic Claude CLI**: `claude-sonnet-5-5`, effort `medium`
  - **Default Sandbox**: `workspace-write`

### Exit Codes
- **Source of Truth**: [`mcp-server/src/core/types.ts`](../mcp-server/src/core/types.ts) (`EXIT_CODES`).
- Canonical numeric exit codes:
  - `0`: **Success** (`SUCCESS`)
  - `1`: **Generic failure** (`GENERIC_FAILURE`)
  - `10`: **Single provider quota exceeded** (`QUOTA_EXCEEDED`)
  - `75`: **All providers depleted / recursive delegation refused** (`ALL_DEPLETED`)
  - `78`: **Configuration / authentication error** (`CONFIG_AUTH_ERROR`)
  - `79`: **Environment failure** (`ENVIRONMENT_FAILURE`, e.g., Codex Windows sandbox setup failed)
  - `124`: **Execution timeout** (`TIMEOUT`)
  - `130`: **Cancelled** (`CANCELLED`)

### Automated Parity Enforcement
- Parity between TypeScript definitions and PowerShell script defaults is strictly enforced by `tests/parity.Tests.ps1`:
  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/parity.Tests.ps1
  ```
- Any modification to default models, effort levels, or exit codes must update both `mcp-server/src/core/` and the PowerShell wrappers synchronously.

---

## 3. PowerShell Skill Package

PowerShell scripts live exclusively in `skills/agent-delegation-tools/scripts/`, and the manifest is `skills/agent-delegation-tools/SKILL.md`. Edit this package directly; `install.ps1` copies it into the supported personal skill directories.

From the repository root:

```powershell
.\skills\agent-delegation-tools\scripts\status.ps1 -Agent all
```

---

## 4. Asynchronous MCP Job Architecture

Desktop MCP hosts (such as Claude Desktop and VS Code) enforce hard internal request timeouts on tool calls (typically 30–60 seconds) and completely ignore server-side timeout configurations such as `MCP_TOOL_TIMEOUT`. Large coding and refactoring tasks running on external CLIs often take several minutes.

To bridge this constraint:
- `delegate_task` and `delegate_parallel` default to `async: true`, dispatching the subagent to a background worker and immediately returning an alphanumeric `job_id`.
- Host agents poll `get_job_result(job_id, wait_sec)` where `wait_sec` defaults to 25s (clamped to a maximum of 50s) until the job status reaches `succeeded`, `failed`, `timed_out`, or `cancelled`.
- `get_job_status` allows listing all tracked jobs or checking lightweight status without blocking.
- `cancel_job(job_id)` sends an abort signal to the running task and cleans up the child process tree using `taskkill /PID <pid> /T /F` (with native fallback).
- Retained completed jobs: Up to 50 finished jobs are retained in-memory for up to 1 hour (pruned by age and count).
- Full process output logs are written to `$TEMP/agent-delegation-logs/<runId>-<agent>.log`, and tool responses provide a tail-truncated view (up to 20,000 characters) pointing to the full log path.
