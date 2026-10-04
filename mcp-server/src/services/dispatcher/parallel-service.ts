import { AgentName, TargetAgent, FallbackAgent, TaskType, SandboxMode, EXIT_CODES, DelegationAttempt } from '../../core/types.js';
import { delegateTask } from './delegate-service.js';
import { EXTERNAL_AGENTS } from '../../core/defaults.js';
import { capOutputTail, generateRunId } from '../../core/logging.js';

export interface ParallelTaskOptions {
  tasks: string[];
  taskType?: TaskType;
  sandbox?: SandboxMode;
  balanceQuota?: boolean;
  agent?: TargetAgent;
  fallbackAgent?: FallbackAgent;
  maxConcurrency?: number;
  workDir?: string;
  timeoutSec?: number;
  agyModel?: string;
  agyEffort?: 'low' | 'medium' | 'high';
  claudeModel?: string;
  claudeEffort?: string;
  codexModel?: string;
  codexEffort?: string;
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
}

export interface ParallelTaskResult {
  index: number;
  prompt: string;
  usedAgent: AgentName;
  exitCode: number;
  output: string;
  durationMs: number;
  attempts?: DelegationAttempt[];
  logPath?: string;
}

export async function delegateParallel(options: ParallelTaskOptions): Promise<ParallelTaskResult[]> {
  const maxConcurrency = Math.max(1, Math.min(16, options.maxConcurrency || 4));
  const results: ParallelTaskResult[] = new Array(options.tasks.length);
  const baseRunId = generateRunId();

  let currentIndex = 0;

  // In "auto" mode the batch is spread round-robin over the two external CLIs so
  // one provider does not absorb the whole burst. delegateTask still fails over
  // per task when the assigned backend turns out to be depleted.
  const autoSpread = !options.agent || options.agent === 'auto';

  async function worker() {
    while (currentIndex < options.tasks.length && !options.signal?.aborted) {
      const idx = currentIndex++;
      const prompt = options.tasks[idx];
      const cappedPrompt = prompt.slice(0, 120);

      const res = await delegateTask({
        prompt,
        taskType: options.taskType,
        sandbox: options.sandbox,
        balanceQuota: options.balanceQuota !== false,
        agent: autoSpread ? EXTERNAL_AGENTS[idx % EXTERNAL_AGENTS.length] : options.agent,
        fallbackAgent: options.fallbackAgent,
        workDir: options.workDir,
        timeoutSec: options.timeoutSec,
        runId: `${baseRunId}-task-${idx}`,
        agyModel: options.agyModel,
        agyEffort: options.agyEffort,
        claudeModel: options.claudeModel,
        claudeEffort: options.claudeEffort,
        codexModel: options.codexModel,
        codexEffort: options.codexEffort,
        signal: options.signal,
        onProgress: options.onProgress,
      });

      results[idx] = {
        index: idx,
        prompt: cappedPrompt,
        usedAgent: res.usedAgent,
        exitCode: res.exitCode,
        output: capOutputTail(res.output || res.stdout || res.stderr, 20000, res.logPath),
        durationMs: res.durationMs,
        attempts: res.attempts,
        logPath: res.logPath,
      };
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, options.tasks.length) }, () => worker());
  await Promise.all(workers);

  // Preserve task indices and report unscheduled work explicitly on cancellation.
  for (let idx = 0; idx < options.tasks.length; idx++) {
    if (!results[idx]) results[idx] = {
      index: idx,
      prompt: options.tasks[idx].slice(0, 120),
      usedAgent: autoSpread ? EXTERNAL_AGENTS[idx % EXTERNAL_AGENTS.length] : (options.agent as AgentName || 'agy'),
      exitCode: EXIT_CODES.CANCELLED,
      output: 'Task cancelled before dispatch.',
      durationMs: 0,
      attempts: [],
    };
  }

  return results;
}
