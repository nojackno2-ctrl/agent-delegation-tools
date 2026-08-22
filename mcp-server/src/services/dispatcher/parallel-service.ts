import { AgentName, TargetAgent, TaskType, SandboxMode } from '../../core/types.js';
import { delegateTask } from './delegate-service.js';

export interface ParallelTaskOptions {
  tasks: string[];
  taskType?: TaskType;
  sandbox?: SandboxMode;
  agent?: TargetAgent;
  maxConcurrency?: number;
  workDir?: string;
  timeoutSec?: number;
}

export interface ParallelTaskResult {
  index: number;
  prompt: string;
  usedAgent: AgentName;
  exitCode: number;
  output: string;
  durationMs: number;
}

export async function delegateParallel(options: ParallelTaskOptions): Promise<ParallelTaskResult[]> {
  const maxConcurrency = Math.max(1, Math.min(16, options.maxConcurrency || 4));
  const results: ParallelTaskResult[] = new Array(options.tasks.length);

  let currentIndex = 0;

  async function worker() {
    while (currentIndex < options.tasks.length) {
      const idx = currentIndex++;
      const prompt = options.tasks[idx];

      const res = await delegateTask({
        prompt,
        taskType: options.taskType,
        sandbox: options.sandbox,
        agent: options.agent,
        workDir: options.workDir,
        timeoutSec: options.timeoutSec,
        balanceQuota: true,
      });

      results[idx] = {
        index: idx,
        prompt,
        usedAgent: res.usedAgent,
        exitCode: res.exitCode,
        output: res.output || res.stdout || res.stderr,
        durationMs: res.durationMs,
      };
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, options.tasks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
