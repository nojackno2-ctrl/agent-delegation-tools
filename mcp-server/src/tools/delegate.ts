import { dispatchJob, ToolContext, ToolResponse } from './execution.js';
import { z } from 'zod';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { TaskType, SandboxMode, TargetAgent, FallbackAgent, DelegationAttempt } from '../core/types.js';
import { DEFAULT_MODELS, DEFAULT_SANDBOX } from '../core/defaults.js';
import { capOutputTail } from '../core/logging.js';
import { validateWorkDir } from '../utils/validation.js';

function formatAttempts(attempts?: DelegationAttempt[]): string {
  if (!attempts || attempts.length === 0) return '';
  if (attempts.length === 1 && attempts[0].exitCode === 0) return '';
  return (
    '\n\nFailover Attempts:\n' +
    attempts
      .map(
        (a, i) =>
          `  [Attempt ${i + 1}: ${a.agent}] Exit ${a.exitCode} (${Math.round(a.durationMs / 1000)}s):\n${a.outputTail ? `    ${a.outputTail.trim().replace(/\n/g, '\n    ')}` : '    (no output)'}`
      )
      .join('\n')
  );
}

export const delegateTaskSchema = z.object({
  async: z.boolean().optional().default(true).describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  prompt: z
    .string()
    .min(1)
    .describe('The task prompt or instructions for the delegated subagent.'),
  task_type: z
    .enum(['analysis', 'implementation', 'review', 'scaffolding'])
    .optional()
    .default('implementation')
    .describe(
      `Task type guiding routing and model defaults: analysis/scaffolding -> AGY (${DEFAULT_MODELS.agy.model} ${DEFAULT_MODELS.agy.effort}), implementation/review -> Codex (${DEFAULT_MODELS.codex.model} ${DEFAULT_MODELS.codex.effort}). The Claude CLI is never auto-selected because it spends the parent agent's own subscription quota.`
    ),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default(DEFAULT_SANDBOX)
    .describe(
      'Sandbox permission boundary. Defaults to workspace-write so the subagent can read and modify files under work_dir without any interactive approval. Use "read-only" only for pure analysis.'
    ),
  balance_quota: z
    .boolean()
    .optional()
    .default(true)
    .describe('Read live subscription quotas for all three CLIs before dispatch and route to the healthiest backend, failing over automatically when one is depleted.'),
  agent: z
    .enum(['auto', 'codex', 'claude', 'agy'])
    .optional()
    .default('auto')
    .describe('Primary agent backend. Defaults to "auto": routes by task_type and live quota health, preferring the two external CLIs (agy, codex). Pass "claude" explicitly to force the Claude CLI.'),
  fallback_agent: z
    .enum(['codex', 'claude', 'agy', 'none'])
    .optional()
    .describe('Explicit fallback provider if primary fails or is depleted. \"none\" pins the run to the primary: no quota-based promotion and no failover.'),
  work_dir: z
    .string()
    .min(1)
    .describe('Absolute path to existing working directory for the subagent.'),
  agy_model: z
    .string()
    .optional()
    .describe(`Model override for Antigravity. Default ${DEFAULT_MODELS.agy.model}; use gemini-3.1-pro for deep architecture work.`),
  agy_effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe(`Reasoning effort for Antigravity. Default ${DEFAULT_MODELS.agy.effort}.`),
  claude_model: z
    .string()
    .optional()
    .describe(`Model override for the Claude CLI subagent. Default ${DEFAULT_MODELS.claude.model}.`),
  claude_effort: z
    .string()
    .optional()
    .describe(`Reasoning effort for the Claude CLI subagent. Default ${DEFAULT_MODELS.claude.effort}.`),
  codex_model: z
    .string()
    .optional()
    .describe(`Model override for the Codex CLI subagent. Default ${DEFAULT_MODELS.codex.model}.`),
  codex_effort: z
    .string()
    .optional()
    .describe(`Reasoning effort for the Codex CLI subagent. Default ${DEFAULT_MODELS.codex.effort}.`),
  timeout_sec: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .default(0)
    .describe('Optional execution timeout in seconds. Default 0 = no limit (wait until the subagent finishes).'),
});

export type DelegateTaskInput = z.input<typeof delegateTaskSchema>;

export async function handleDelegateTask(rawInput: DelegateTaskInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return {
      isError: true,
      content: [{ type: 'text', text: dirCheck.error! }],
    };
  }

  const input = delegateTaskSchema.parse(rawInput);
  if (input.async) return dispatchJob('delegate_task', jobContext => handleDelegateTask({ ...input, async: false }, jobContext));
  try {
    const result = await delegateTask({
      prompt: input.prompt,
      taskType: input.task_type as TaskType,
      sandbox: input.sandbox as SandboxMode,
      balanceQuota: input.balance_quota,
      agent: input.agent as TargetAgent,
      fallbackAgent: input.fallback_agent as FallbackAgent,
      workDir: input.work_dir,
      signal: context.signal,
      onProgress: context.onProgress,
      agyModel: input.agy_model,
      agyEffort: input.agy_effort,
      claudeModel: input.claude_model,
      claudeEffort: input.claude_effort,
      codexModel: input.codex_model,
      codexEffort: input.codex_effort,
      timeoutSec: input.timeout_sec,
    });

    context.onResult?.(result);
    const textOutput = result.output || result.stdout || result.stderr;
    const logInfo = result.logPath ? `Log: ${result.logPath}\n` : '';
    const attemptsInfo = formatAttempts(result.attempts);

    if (result.exitCode !== 0) {
      const parts: string[] = [];
      if (result.stdout && result.stdout.trim()) {
        parts.push(`Stdout:\n${capOutputTail(result.stdout, 10000, result.logPath)}`);
      }
      if (result.stderr && result.stderr.trim()) {
        parts.push(`Stderr:\n${capOutputTail(result.stderr, 10000, result.logPath)}`);
      }
      const failureDetails = parts.length > 0 ? parts.join('\n\n') : (capOutputTail(textOutput, 10000, result.logPath) || 'No output recorded.');

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Delegation to [${result.usedAgent}] failed (Exit ${result.exitCode}):\n${logInfo}\n${failureDetails}${attemptsInfo}`,
          },
        ],
      };
    }

    const cappedOutput = capOutputTail(textOutput, 20000, result.logPath);
    return {
      content: [
        {
          type: 'text',
          text: `[Delegated to ${result.usedAgent}] (Duration: ${Math.round(result.durationMs / 1000)}s)\n${logInfo}\n${cappedOutput}${attemptsInfo}`,
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unexpected delegation error: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}

export const delegateParallelSchema = z.object({
  async: z.boolean().optional().default(true).describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  tasks: z
    .array(z.string().min(1))
    .min(1)
    .describe('List of task prompts to execute in parallel.'),
  task_type: z
    .enum(['analysis', 'implementation', 'review', 'scaffolding'])
    .optional()
    .default('implementation')
    .describe(
      `Task type guiding routing and model defaults: analysis/scaffolding -> AGY (${DEFAULT_MODELS.agy.model} ${DEFAULT_MODELS.agy.effort}), implementation/review -> Codex (${DEFAULT_MODELS.codex.model} ${DEFAULT_MODELS.codex.effort}). The Claude CLI is never auto-selected because it spends the parent agent's own subscription quota.`
    ),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default(DEFAULT_SANDBOX)
    .describe('Sandbox boundary for batch execution. Defaults to workspace-write so workers can edit files without approval prompts.'),
  balance_quota: z
    .boolean()
    .optional()
    .default(true)
    .describe('Read live subscription quotas for all three CLIs before dispatch and route to healthiest external CLIs, failing over automatically when one is depleted.'),
  agent: z
    .enum(['auto', 'codex', 'claude', 'agy'])
    .optional()
    .default('auto')
    .describe('Agent backend for parallel workers. "auto" spreads the batch round-robin across the external CLIs with per-task quota failover.'),
  fallback_agent: z
    .enum(['codex', 'claude', 'agy', 'none'])
    .optional()
    .describe('Explicit fallback provider if primary fails or is depleted. \"none\" pins the run to the primary: no quota-based promotion and no failover.'),
  max_concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .default(4)
    .describe('Maximum concurrent subagent workers.'),
  work_dir: z
    .string()
    .min(1)
    .describe('Absolute path to existing working directory for the subagent.'),
  agy_model: z
    .string()
    .optional()
    .describe(`Model override for Antigravity. Default ${DEFAULT_MODELS.agy.model}; use gemini-3.1-pro for deep architecture work.`),
  agy_effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe(`Reasoning effort for Antigravity. Default ${DEFAULT_MODELS.agy.effort}.`),
  claude_model: z
    .string()
    .optional()
    .describe(`Model override for the Claude CLI subagent. Default ${DEFAULT_MODELS.claude.model}.`),
  claude_effort: z
    .string()
    .optional()
    .describe(`Reasoning effort for the Claude CLI subagent. Default ${DEFAULT_MODELS.claude.effort}.`),
  codex_model: z
    .string()
    .optional()
    .describe(`Model override for the Codex CLI subagent. Default ${DEFAULT_MODELS.codex.model}.`),
  codex_effort: z
    .string()
    .optional()
    .describe(`Reasoning effort for the Codex CLI subagent. Default ${DEFAULT_MODELS.codex.effort}.`),
  timeout_sec: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .default(0)
    .describe('Optional execution timeout in seconds per task. Default 0 = no limit (wait until each subagent finishes).'),
});

export type DelegateParallelInput = z.input<typeof delegateParallelSchema>;

export async function handleDelegateParallel(rawInput: DelegateParallelInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return {
      isError: true,
      content: [{ type: 'text', text: dirCheck.error! }],
    };
  }

  const input = delegateParallelSchema.parse(rawInput);
  if (input.async) return dispatchJob('delegate_parallel', jobContext => handleDelegateParallel({ ...input, async: false }, jobContext));
  try {
    const results = await delegateParallel({
      tasks: input.tasks,
      taskType: input.task_type as TaskType,
      sandbox: input.sandbox as SandboxMode,
      balanceQuota: input.balance_quota,
      agent: input.agent as TargetAgent,
      fallbackAgent: input.fallback_agent as FallbackAgent,
      maxConcurrency: input.max_concurrency,
      workDir: input.work_dir,
      timeoutSec: input.timeout_sec,
      agyModel: input.agy_model,
      agyEffort: input.agy_effort,
      claudeModel: input.claude_model,
      claudeEffort: input.claude_effort,
      codexModel: input.codex_model,
      codexEffort: input.codex_effort,
      signal: context.signal,
      onProgress: context.onProgress,
    });

    context.onResult?.(results);
    return {
      isError: results.some(result => result.exitCode !== 0),
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Parallel delegation error: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}
