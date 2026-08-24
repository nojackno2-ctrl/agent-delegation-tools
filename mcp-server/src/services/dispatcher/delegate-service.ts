import { AgentName, TargetAgent, FallbackAgent, TaskType, SandboxMode, ExecutionResult, EXIT_CODES } from '../../core/types.js';
import { getDynamicQuotaHealth, markProviderDepleted } from '../quota/quota-service.js';
import { invokeAgy } from '../invokers/agy-invoker.js';
import { invokeCodex } from '../invokers/codex-invoker.js';
import { invokeClaude } from '../invokers/claude-invoker.js';
import { DEFAULT_SANDBOX, isExternalAgent, isWriteSandbox } from '../../core/defaults.js';

export interface DelegateOptions {
  prompt: string;
  taskType?: TaskType;
  sandbox?: SandboxMode;
  balanceQuota?: boolean;
  agent?: TargetAgent;
  fallbackAgent?: FallbackAgent;
  workDir?: string;
  agyModel?: string;
  agyEffort?: 'low' | 'medium' | 'high';
  claudeModel?: string;
  claudeEffort?: string;
  codexModel?: string;
  codexEffort?: string;
  timeoutSec?: number;
}

export async function delegateTask(options: DelegateOptions): Promise<ExecutionResult & { usedAgent: AgentName }> {
  const taskType = options.taskType || 'implementation';
  const sandbox = options.sandbox || DEFAULT_SANDBOX;
  const balanceQuota = options.balanceQuota !== false;

  // Auto-routing only ever picks an external CLI. The Claude CLI draws on the
  // same subscription as the parent agent, so delegating to it offloads context
  // but not quota; it is reachable only by naming it explicitly.
  const explicitAgent = options.agent && options.agent !== 'auto' ? options.agent : null;
  let primaryAgent: AgentName;
  if (explicitAgent) {
    primaryAgent = explicitAgent;
  } else {
    switch (taskType) {
      case 'implementation':
      case 'review':
        primaryAgent = 'codex';
        break;
      case 'analysis':
      case 'scaffolding':
      default:
        primaryAgent = 'agy';
        break;
    }
  }

  const fallbackChain: AgentName[] = [];
  if (options.fallbackAgent && options.fallbackAgent !== 'none') {
    if (options.fallbackAgent !== primaryAgent) {
      fallbackChain.push(options.fallbackAgent);
    }
  }

  // Dynamic quota-aware load balancing: read the live subscription state of all
  // three CLIs and rank the healthy ones. External providers always outrank the
  // Claude CLI, which is only reachable as a last resort or when named directly.
  if (balanceQuota) {
    try {
      const healthMap = await getDynamicQuotaHealth({ workDir: options.workDir, timeoutSec: 15 });

      const rank = (a: AgentName, b: AgentName) => {
        const externalDelta = Number(isExternalAgent(b)) - Number(isExternalAgent(a));
        if (externalDelta !== 0) return externalDelta;
        return healthMap[b].minRemainingPercent - healthMap[a].minRemainingPercent;
      };

      const available = (Object.keys(healthMap) as AgentName[]).filter((a) => healthMap[a].available);
      const externalsUsable = available.some(isExternalAgent);

      // The Claude CLI joins the chain only when it was named explicitly or when
      // neither external CLI is usable.
      const healthy = available
        .filter((a) => isExternalAgent(a) || a === explicitAgent || !externalsUsable)
        .sort(rank);

      const primaryHealth = healthMap[primaryAgent];

      if (primaryHealth && !primaryHealth.available && healthy.length > 0) {
        // Primary is depleted or logged out: promote the best remaining backend.
        primaryAgent = healthy[0];
        fallbackChain.length = 0;
        fallbackChain.push(...healthy.slice(1));
      } else {
        // Primary is healthy; queue the rest as ordered failover candidates.
        for (const cand of healthy) {
          if (cand !== primaryAgent && !fallbackChain.includes(cand)) {
            fallbackChain.push(cand);
          }
        }
      }
    } catch {
      // If the health query fails, proceed with the statically routed primary.
    }
  }

  const candidateAgents: AgentName[] = [primaryAgent, ...fallbackChain];

  async function executeOnAgent(agentName: AgentName): Promise<ExecutionResult> {
    switch (agentName) {
      case 'agy':
        return await invokeAgy({
          prompt: options.prompt,
          mode: isWriteSandbox(sandbox) ? 'accept-edits' : 'plan',
          model: options.agyModel,
          effort: options.agyEffort,
          workDir: options.workDir,
          timeoutSec: options.timeoutSec,
        });
      case 'codex':
        return await invokeCodex({
          prompt: options.prompt,
          sandbox,
          model: options.codexModel,
          effort: options.codexEffort,
          workDir: options.workDir,
          timeoutSec: options.timeoutSec,
        });
      case 'claude':
        return await invokeClaude({
          prompt: options.prompt,
          mode: sandbox,
          model: options.claudeModel,
          effort: options.claudeEffort,
          workDir: options.workDir,
          timeoutSec: options.timeoutSec,
        });
    }
  }

  let lastResult: ExecutionResult = {
    exitCode: EXIT_CODES.ALL_DEPLETED,
    stdout: '',
    stderr: 'No candidates available.',
    durationMs: 0,
  };

  for (let i = 0; i < candidateAgents.length; i++) {
    const currentAgent = candidateAgents[i];
    const res = await executeOnAgent(currentAgent);

    if (res.exitCode === EXIT_CODES.SUCCESS) {
      return {
        ...res,
        usedAgent: currentAgent,
      };
    }

    lastResult = res;

    // If failed due to quota limit (10) or auth error (78), mark depleted and continue to next candidate
    if (res.exitCode === EXIT_CODES.QUOTA_EXCEEDED) {
      markProviderDepleted(currentAgent);
      continue;
    }

    if (res.exitCode === EXIT_CODES.CONFIG_AUTH_ERROR) {
      continue;
    }

    // For other exit codes, break and return
    return {
      ...res,
      usedAgent: currentAgent,
    };
  }

  return {
    ...lastResult,
    usedAgent: candidateAgents[candidateAgents.length - 1] || primaryAgent,
  };
}
