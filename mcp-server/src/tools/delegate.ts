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
    .default('analysis')
    .describe('Task type to guide routing and model defaults (analysis/scaffolding -> AGY Flash, implementation -> Codex, review -> Claude).'),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('read-only')
    .describe('Sandbox permission boundary. Use "workspace-write" when modifying files in the repo.'),
  balance_quota: z
    .boolean()
    .optional()
    .default(true)
    .describe('Automatically check live quota status and rebalance away from exhausted/unavailable backends.'),
  agent: z
    .enum(['auto', 'codex', 'claude', 'agy'])
    .optional()
    .default('auto')
    .describe('Primary agent backend. Defaults to "auto" (routes by task_type and quota health).'),
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
    .describe('Model for Antigravity (e.g. "gemini-3.7-flash", "gemini-3.1-pro").'),
  agy_effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Reasoning effort for Antigravity models.'),
  claude_model: z
    .string()
    .optional()
    .describe('Model override for Claude Code subagent.'),
  codex_model: z
    .string()
    .optional()
    .describe('Model override for Codex CLI subagent.'),
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
      codexModel: input.codex_model,
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
    .default('analysis')
    .describe('Task type for all batch tasks.'),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('read-only')
    .describe('Sandbox boundary for batch execution.'),
  agent: z
    .enum(['auto', 'codex', 'claude', 'agy'])
    .optional()
    .default('auto')
    .describe('Agent backend for parallel workers.'),
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
