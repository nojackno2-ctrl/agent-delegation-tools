import { AgentName, TargetAgent, FallbackAgent, TaskType, SandboxMode, ExecutionResult, EXIT_CODES } from '../../core/types.js';
import { getDynamicQuotaHealth, markProviderDepleted } from '../quota/quota-service.js';
import { invokeAgy } from '../invokers/agy-invoker.js';
import { invokeCodex } from '../invokers/codex-invoker.js';
import { invokeClaude } from '../invokers/claude-invoker.js';

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
  codexModel?: string;
  timeoutSec?: number;
}

export async function delegateTask(options: DelegateOptions): Promise<ExecutionResult & { usedAgent: AgentName }> {
  const taskType = options.taskType || 'analysis';
  const sandbox = options.sandbox || 'read-only';
  const balanceQuota = options.balanceQuota !== false;

  // Determine initial target agent
  let primaryAgent: AgentName;
  if (options.agent && options.agent !== 'auto') {
    primaryAgent = options.agent;
  } else {
    switch (taskType) {
      case 'implementation':
        primaryAgent = 'codex';
        break;
      case 'review':
        primaryAgent = 'claude';
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

  // Dynamic Quota-Aware Load Balancing
  if (balanceQuota) {
    try {
      const healthMap = await getDynamicQuotaHealth({ workDir: options.workDir, timeoutSec: 15 });
      const primaryHealth = healthMap[primaryAgent];

      // If primary is not healthy, rebalance to the healthiest provider
      if (primaryHealth && !primaryHealth.available) {
        const sorted = (Object.keys(healthMap) as AgentName[])
          .filter((a) => healthMap[a].available)
          .sort((a, b) => healthMap[b].minRemainingPercent - healthMap[a].minRemainingPercent);

        if (sorted.length > 0) {
          const rebalancedPrimary = sorted[0];
          fallbackChain.length = 0;
          for (let i = 1; i < sorted.length; i++) {
            fallbackChain.push(sorted[i]);
          }
          primaryAgent = rebalancedPrimary;
        }
      } else {
        // Primary is healthy; add other healthy providers to fallback chain
        const otherHealthy = (Object.keys(healthMap) as AgentName[])
          .filter((a) => a !== primaryAgent && healthMap[a].available)
          .sort((a, b) => healthMap[b].minRemainingPercent - healthMap[a].minRemainingPercent);

        for (const cand of otherHealthy) {
          if (!fallbackChain.includes(cand)) {
            fallbackChain.push(cand);
          }
        }
      }
    } catch {
      // If health query fails, proceed with default primary
    }
  }

  const candidateAgents: AgentName[] = [primaryAgent, ...fallbackChain];

  async function executeOnAgent(agentName: AgentName): Promise<ExecutionResult> {
    switch (agentName) {
      case 'agy':
        return await invokeAgy({
          prompt: options.prompt,
          mode: sandbox === 'workspace-write' || sandbox === 'danger-full-access' ? 'accept-edits' : 'plan',
          model: options.agyModel,
          effort: options.agyEffort,
          workDir: options.workDir,
          timeoutSec: options.timeoutSec,
          skipPermissions: sandbox === 'workspace-write' || sandbox === 'danger-full-access',
        });
      case 'codex':
        return await invokeCodex({
          prompt: options.prompt,
          sandbox,
          model: options.codexModel,
          workDir: options.workDir,
          timeoutSec: options.timeoutSec,
          approveForMe: sandbox === 'workspace-write' || sandbox === 'danger-full-access',
        });
      case 'claude':
        return await invokeClaude({
          prompt: options.prompt,
          mode: sandbox,
          model: options.claudeModel,
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
