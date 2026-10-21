import { AgentName, SandboxMode } from './types.js';

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
  agy: { model: 'gemini-3.8-flash', effort: 'medium' },
  codex: { model: 'gpt-6.1-sol', effort: 'medium' },
  claude: { model: 'claude-sonnet-5-5', effort: 'medium' },
} as const satisfies Record<AgentName, { model: string; effort: string }>;

/**
 * Delegated subagents are automation, not interactive sessions: a permission
 * prompt in a headless child is a hang, not a safety net. Work is bounded by
 * `work_dir` instead.
 */
export const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';

/**
 * Auto-routing preference. The two external providers carry the load; the
 * Claude CLI spends the same subscription quota as the parent agent, so it is
 * the last resort unless the caller names it explicitly.
 */
export const EXTERNAL_AGENTS: AgentName[] = ['agy', 'codex'];

/** True when the backend is one of the two external (non-Claude-quota) CLIs. */
export function isExternalAgent(agent: AgentName): boolean {
  return EXTERNAL_AGENTS.includes(agent);
}

/** Sandboxes that imply the subagent may create/modify files. */
export function isWriteSandbox(sandbox: SandboxMode | undefined): boolean {
  return sandbox === 'workspace-write' || sandbox === 'danger-full-access';
}
