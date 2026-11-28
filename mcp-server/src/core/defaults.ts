import { AgentName, SandboxMode, TaskType } from './types.js';

/** Text-only local backend; deliberately excluded from AgentName and auto-routing. */
export const DEFAULT_LOCAL_MODEL = process.env.LOCAL_AI_MODEL?.trim() || 'laguna-xs-2.1:latest';

/** Local Ollama models callers may use: the default plus comma-separated LOCAL_AI_MODELS. */
export function allowedLocalModels(): Set<string> {
  return new Set([DEFAULT_LOCAL_MODEL, ...(process.env.LOCAL_AI_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean)]);
}

/**
 * Codex profile (`$CODEX_HOME/<name>.config.toml`) that points Codex at local
 * Ollama. A Codex run whose model is a local model is launched with `-p <profile>`
 * and does not spend OpenAI quota.
 */
export function codexLocalProfile(model: string | undefined): string | undefined {
  return model && allowedLocalModels().has(model) ? (process.env.CODEX_LOCAL_PROFILE?.trim() || 'ollama') : undefined;
}

/**
 * Project-wide delegation policy.
 *
 * The parent agent is expected to push work OUT to the external CLIs instead of
 * spending its own Claude context/quota on subagents, so every default here is
 * tuned for "delegate first, write-capable, never block on a prompt".
 */

/** Default model + reasoning effort per backend. Overridable per call. */
export const DEFAULT_MODELS = {
  agy: { model: 'gemini-4-hydrogen', effort: 'low' },
  codex: { model: 'gpt-6.1-terra', effort: 'low' },
  claude: { model: 'claude-sonnet-5-5', effort: 'low' },
} as const satisfies Record<AgentName, { model: string; effort: string }>;

/**
 * Strongest callable model + reasoning effort per backend for Advisor Mode.
 * Used by consult_advisor / advisor.ps1 so a cheaper executor in any host
 * (Claude, AGY, or Codex) can consult the top-tier model of any provider.
 */
export const ADVISOR_MODELS = {
  agy: { model: 'gemini-4-neon', effort: 'xhigh' },
  codex: { model: 'gpt-6.2-astra', effort: 'max' },
  claude: { model: 'claude-opus-5-5', effort: 'max' },
} as const satisfies Record<AgentName, { model: string; effort: string }>;

/**
 * Delegated subagents are automation, not interactive sessions: a permission
 * prompt in a headless child is a hang, not a safety net. Work is bounded by
 * `work_dir` instead.
 */
export const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';

/**
 * Host agent running this MCP server, read from DELEGATION_HOST.
 * Defaults to 'claude' for backward compatibility.
 */
export function getHostAgent(env: NodeJS.ProcessEnv = process.env): AgentName {
  const raw = env.DELEGATION_HOST?.trim().toLowerCase();
  if (raw === 'agy' || raw === 'codex' || raw === 'claude') {
    return raw;
  }
  return 'claude';
}

/**
 * External CLI backends (the two providers that do NOT share the host's own
 * subscription quota).
 */
export function getExternalAgents(host: AgentName = getHostAgent()): AgentName[] {
  switch (host) {
    case 'agy':
      return ['codex', 'claude'];
    case 'codex':
      return ['agy', 'claude'];
    case 'claude':
    default:
      return ['agy', 'codex'];
  }
}

/**
 * Auto-routing preference for Claude hosts (kept for backward compatibility).
 */
export const EXTERNAL_AGENTS: AgentName[] = ['agy', 'codex'];

/** True when the backend is one of the two external (non-host-quota) CLIs. */
export function isExternalAgent(agent: AgentName, host: AgentName = getHostAgent()): boolean {
  return getExternalAgents(host).includes(agent);
}

/** Default primary agent for a task_type given the active host agent. */
export function defaultAgentForTaskType(taskType: TaskType, host: AgentName = getHostAgent()): AgentName {
  switch (host) {
    case 'agy':
      switch (taskType) {
        case 'implementation':
        case 'scaffolding':
          return 'codex';
        case 'review':
        case 'analysis':
        default:
          return 'claude';
      }
    case 'codex':
      switch (taskType) {
        case 'analysis':
        case 'scaffolding':
          return 'agy';
        case 'implementation':
        case 'review':
        default:
          return 'claude';
      }
    case 'claude':
    default:
      switch (taskType) {
        case 'implementation':
        case 'review':
          return 'codex';
        case 'analysis':
        case 'scaffolding':
        default:
          return 'agy';
      }
  }
}

/** Sandboxes that imply the subagent may create/modify files. */
export function isWriteSandbox(sandbox: SandboxMode | undefined): boolean {
  return sandbox === 'workspace-write' || sandbox === 'danger-full-access';
}
