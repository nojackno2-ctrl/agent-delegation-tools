import { AgentName, SandboxMode } from './types.js';

/**
 * Project-wide delegation policy.
 *
 * The parent agent is expected to push work OUT to the external CLIs instead of
 * spending its own Claude context/quota on subagents, so every default here is
 * tuned for "delegate first, write-capable, never block on a prompt".
 */

/** Default model + reasoning effort per backend. Overridable per call. */
export const DEFAULT_MODELS = {
  agy: { model: 'gemini-3.7-flash', effort: 'high' },
  codex: { model: 'gpt-5.6-luna', effort: 'high' },
  claude: { model: 'claude-sonnet-5', effort: 'high' },
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
export const AGENT_PRIORITY: AgentName[] = ['agy', 'codex', 'claude'];

/** True when the backend is one of the two external (non-Claude-quota) CLIs. */
export function isExternalAgent(agent: AgentName): boolean {
  return EXTERNAL_AGENTS.includes(agent);
}

/** Sandboxes that imply the subagent may create/modify files. */
export function isWriteSandbox(sandbox: SandboxMode | undefined): boolean {
  return sandbox === 'workspace-write' || sandbox === 'danger-full-access';
}
