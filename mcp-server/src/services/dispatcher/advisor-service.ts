import { ADVISOR_MODELS } from '../../core/defaults.js';
import { AgentName, DelegationAttempt, ExecutionResult, FallbackAgent, TargetAgent } from '../../core/types.js';
import { delegateTask } from './delegate-service.js';

export type AdvisorEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AdvisorConfig {
  advisor: TargetAgent;
  model?: string;
  effort?: AdvisorEffort;
  fallbackAgent?: FallbackAgent;
}

export interface UpdateAdvisorConfigInput {
  advisor?: TargetAgent;
  model?: string;
  effort?: AdvisorEffort;
  fallbackAgent?: FallbackAgent;
  reset?: boolean;
}

export interface ConsultAdvisorOptions {
  question: string;
  context?: string;
  advisor?: TargetAgent;
  fallbackAgent?: FallbackAgent;
  balanceQuota?: boolean;
  workDir: string;
  model?: string;
  effort?: AdvisorEffort;
  timeoutSec?: number;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
}

export type ConsultAdvisorResult = ExecutionResult & {
  usedAgent: AgentName;
  advisorModel: string;
  advisorEffort: string;
  attempts: DelegationAttempt[];
  logPath?: string;
};

const VALID_ADVISORS: readonly TargetAgent[] = ['auto', 'agy', 'codex', 'claude'];
const VALID_EFFORTS: readonly AdvisorEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function readEnvDefaultConfig(): AdvisorConfig {
  const rawAdvisor = process.env.DELEGATION_ADVISOR?.trim().toLowerCase() as TargetAgent | undefined;
  const advisor: TargetAgent = rawAdvisor && VALID_ADVISORS.includes(rawAdvisor) ? rawAdvisor : 'auto';
  const model = process.env.DELEGATION_ADVISOR_MODEL?.trim() || undefined;
  const rawEffort = process.env.DELEGATION_ADVISOR_EFFORT?.trim().toLowerCase() as AdvisorEffort | undefined;
  const effort = rawEffort && VALID_EFFORTS.includes(rawEffort) ? rawEffort : undefined;
  return {
    advisor,
    ...(advisor !== 'auto' && model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

let sessionAdvisorConfig: AdvisorConfig = readEnvDefaultConfig();

export function getAdvisorConfig(): AdvisorConfig {
  return { ...sessionAdvisorConfig };
}

export function resetAdvisorConfig(): AdvisorConfig {
  sessionAdvisorConfig = readEnvDefaultConfig();
  return getAdvisorConfig();
}

export function setAdvisorConfig(input: UpdateAdvisorConfigInput): AdvisorConfig {
  if (input.reset) {
    sessionAdvisorConfig = readEnvDefaultConfig();
  }

  const next: AdvisorConfig = { ...sessionAdvisorConfig };
  const advisorChanged = input.advisor !== undefined && input.advisor !== sessionAdvisorConfig.advisor;

  if (input.advisor !== undefined) {
    next.advisor = input.advisor;
  }

  // Switching providers clears any previous provider-specific model/effort override
  // unless the caller explicitly supplied new ones in the same call.
  if (advisorChanged) {
    if (input.model === undefined) delete next.model;
    if (input.effort === undefined) delete next.effort;
  }

  if (input.model !== undefined) {
    const trimmed = input.model.trim();
    if (trimmed) next.model = trimmed;
    else delete next.model;
  }

  if (input.effort !== undefined) {
    next.effort = input.effort;
  }

  if (input.fallbackAgent !== undefined) {
    next.fallbackAgent = input.fallbackAgent;
  }

  // Model override only makes sense when pinned to a specific provider; ignore stale model on auto.
  if (next.advisor === 'auto' && input.model === undefined) {
    delete next.model;
  }

  sessionAdvisorConfig = next;
  return getAdvisorConfig();
}

export function buildAdvisorPrompt(question: string, context?: string): string {
  const sections: string[] = [
    '[Advisor Mode - Read-Only Consultation]',
    'You are acting as a senior technical advisor for an executor agent working in this workspace.',
    'Rules:',
    '- Read-only consultation only: do NOT create, edit, or delete files, and do NOT run mutating commands.',
    '- You may inspect files in the workspace to verify facts before advising.',
    '- Provide concise, high-signal, actionable guidance: root-cause analysis, recommended solution steps, trade-offs, edge cases, and concrete file/line references so the executor can apply the fix directly.',
    '',
    'Question:',
    question.trim(),
  ];

  if (context && context.trim()) {
    sections.push('', 'Context / What has been tried:', context.trim());
  }

  return sections.join('\n');
}

export function resolveAdvisorModels(
  targetAdvisor: TargetAgent,
  modelOverride?: string,
  effortOverride?: AdvisorEffort
): Record<AgentName, { model: string; effort: AdvisorEffort }> {
  const resolved: Record<AgentName, { model: string; effort: AdvisorEffort }> = {
    agy: { model: ADVISOR_MODELS.agy.model, effort: ADVISOR_MODELS.agy.effort },
    codex: { model: ADVISOR_MODELS.codex.model, effort: ADVISOR_MODELS.codex.effort },
    claude: { model: ADVISOR_MODELS.claude.model, effort: ADVISOR_MODELS.claude.effort },
  };

  if (targetAdvisor !== 'auto') {
    if (modelOverride && modelOverride.trim()) {
      resolved[targetAdvisor].model = modelOverride.trim();
    }
    if (effortOverride) {
      resolved[targetAdvisor].effort = effortOverride;
    }
  } else if (effortOverride) {
    for (const agent of ['agy', 'codex', 'claude'] as const) {
      resolved[agent].effort = effortOverride;
    }
  }

  return resolved;
}

export async function consultAdvisor(options: ConsultAdvisorOptions): Promise<ConsultAdvisorResult> {
  const cfg = getAdvisorConfig();
  const effectiveAdvisor: TargetAgent = options.advisor ?? cfg.advisor;
  const effectiveFallback: FallbackAgent | undefined = options.fallbackAgent ?? cfg.fallbackAgent;

  // Only inherit session model/effort override when using the same advisor as the session config.
  const inheritSessionOverrides = options.advisor === undefined || options.advisor === cfg.advisor;
  const effectiveModel = options.model ?? (inheritSessionOverrides ? cfg.model : undefined);
  const effectiveEffort = options.effort ?? (inheritSessionOverrides ? cfg.effort : undefined);

  const perAgent = resolveAdvisorModels(effectiveAdvisor, effectiveModel, effectiveEffort);
  const prompt = buildAdvisorPrompt(options.question, options.context);

  const result = await delegateTask({
    prompt,
    taskType: 'analysis',
    sandbox: 'read-only',
    balanceQuota: options.balanceQuota !== false,
    agent: effectiveAdvisor,
    fallbackAgent: effectiveFallback,
    workDir: options.workDir,
    agyModel: perAgent.agy.model,
    agyEffort: perAgent.agy.effort,
    codexModel: perAgent.codex.model,
    codexEffort: perAgent.codex.effort,
    claudeModel: perAgent.claude.model,
    claudeEffort: perAgent.claude.effort,
    timeoutSec: options.timeoutSec,
    runId: options.runId,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  const usedSpec = perAgent[result.usedAgent];
  return {
    ...result,
    advisorModel: usedSpec.model,
    advisorEffort: usedSpec.effort,
  };
}
