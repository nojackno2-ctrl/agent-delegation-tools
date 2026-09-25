import { z } from 'zod';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { TaskType, SandboxMode, TargetAgent, FallbackAgent } from '../core/types.js';

export const delegateTaskSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('The task prompt or instructions for the delegated subagent.'),
  task_type: z
    .enum(['analysis', 'implementation', 'review', 'scaffolding'])
    .optional()
    .default('implementation')
    .describe(
      'Task type guiding routing and model defaults: analysis/scaffolding -> AGY (Gemini 3.8 Flash medium), implementation/review -> Codex (GPT-6-Luna medium). The Claude CLI is never auto-selected because it spends the parent agent\'s own subscription quota.'
    ),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('workspace-write')
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
    .describe('Explicit fallback provider if primary fails or is depleted.'),
  work_dir: z
    .string()
    .optional()
    .describe('Absolute path to working directory for the subagent.'),
  agy_model: z
    .string()
    .optional()
    .describe('Model override for Antigravity. Default gemini-3.8-flash; use gemini-3.1-pro for deep architecture work.'),
  agy_effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Reasoning effort for Antigravity. Default medium.'),
  claude_model: z
    .string()
    .optional()
    .describe('Model override for the Claude CLI subagent. Default claude-sonnet-5.'),
  claude_effort: z
    .string()
    .optional()
    .describe('Reasoning effort for the Claude CLI subagent. Default medium.'),
  codex_model: z
    .string()
    .optional()
    .describe('Model override for the Codex CLI subagent. Default gpt-6-luna.'),
  codex_effort: z
    .string()
    .optional()
    .describe('Reasoning effort for the Codex CLI subagent. Default medium.'),
  timeout_sec: z
    .number()
    .int()
    .min(10)
    .max(3600)
    .optional()
    .default(900)
    .describe('Maximum execution timeout in seconds.'),
});

export type DelegateTaskInput = z.infer<typeof delegateTaskSchema>;

export async function handleDelegateTask(input: DelegateTaskInput) {
  try {
    const result = await delegateTask({
      prompt: input.prompt,
      taskType: input.task_type as TaskType,
      sandbox: input.sandbox as SandboxMode,
      balanceQuota: input.balance_quota,
      agent: input.agent as TargetAgent,
      fallbackAgent: input.fallback_agent as FallbackAgent,
      workDir: input.work_dir,
      agyModel: input.agy_model,
      agyEffort: input.agy_effort,
      claudeModel: input.claude_model,
      claudeEffort: input.claude_effort,
      codexModel: input.codex_model,
      codexEffort: input.codex_effort,
      timeoutSec: input.timeout_sec,
    });

    const textOutput = result.output || result.stdout || result.stderr;

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Delegation to [${result.usedAgent}] failed (Exit ${result.exitCode}):\n${result.stderr || textOutput}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `[Delegated to ${result.usedAgent}] (Duration: ${Math.round(result.durationMs / 1000)}s)\n\n${textOutput}`,
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
  tasks: z
    .array(z.string().min(1))
    .min(1)
    .describe('List of task prompts to execute in parallel.'),
  task_type: z
    .enum(['analysis', 'implementation', 'review', 'scaffolding'])
    .optional()
    .default('implementation')
    .describe('Task type for all batch tasks.'),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('workspace-write')
    .describe('Sandbox boundary for batch execution. Defaults to workspace-write so workers can edit files without approval prompts.'),
  agent: z
    .enum(['auto', 'codex', 'claude', 'agy'])
    .optional()
    .default('auto')
    .describe('Agent backend for parallel workers. "auto" spreads the batch across the two external CLIs by live quota headroom.'),
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
    .optional()
    .describe('Working directory context.'),
});

export type DelegateParallelInput = z.infer<typeof delegateParallelSchema>;

export async function handleDelegateParallel(input: DelegateParallelInput) {
  try {
    const results = await delegateParallel({
      tasks: input.tasks,
      taskType: input.task_type as TaskType,
      sandbox: input.sandbox as SandboxMode,
      agent: input.agent as TargetAgent,
      maxConcurrency: input.max_concurrency,
      workDir: input.work_dir,
    });

    return {
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
