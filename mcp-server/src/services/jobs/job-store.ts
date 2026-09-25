import { randomUUID } from 'node:crypto';

/**
 * Background job store for long-running delegations.
 *
 * MCP clients abort a tools/call after their request timeout (the TypeScript SDK
 * default is 60s), while a real subagent turn routinely takes minutes. Instead of
 * holding the request open, the handler runs as a job: the call waits a bounded
 * time and, if the work is still running, returns a job id the host polls with
 * get_delegation_result. The subagent keeps running either way.
 */

export interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

export type JobStatus = 'running' | 'completed' | 'failed';

export interface Job {
  id: string;
  tool: string;
  summary: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  result?: ToolResult;
  promise: Promise<ToolResult>;
}

/** Stay safely under the 60s SDK request timeout. */
export const DEFAULT_WAIT_SEC = 45;
export const MAX_WAIT_SEC = 50;
const FINISHED_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_FINISHED_JOBS = 200;

const jobs = new Map<string, Job>();

function prune(now = Date.now()): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  finished.forEach((job, i) => {
    const expired = now - (job.finishedAt ?? now) > FINISHED_RETENTION_MS;
    const overflow = finished.length - i > MAX_FINISHED_JOBS;
    if (expired || overflow) jobs.delete(job.id);
  });
}

export function startJob(tool: string, summary: string, run: () => Promise<ToolResult>): Job {
  prune();
  const job: Job = {
    id: `job_${randomUUID().slice(0, 8)}`,
    tool,
    summary,
    status: 'running',
    startedAt: Date.now(),
  } as Job;

  job.promise = Promise.resolve()
    .then(run)
    .catch(
      (error: any): ToolResult => ({
        isError: true,
        content: [{ type: 'text', text: `Job ${job.id} crashed: ${error?.message || String(error)}` }],
      })
    )
    .then((result) => {
      job.result = result;
      job.status = result.isError ? 'failed' : 'completed';
      job.finishedAt = Date.now();
      return result;
    });

  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  prune();
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function clampWaitSec(waitSec: number | undefined): number {
  if (waitSec === undefined || !Number.isFinite(waitSec)) return DEFAULT_WAIT_SEC;
  return Math.max(0, Math.min(MAX_WAIT_SEC, waitSec));
}

/**
 * Wait up to waitSec for the job. Calls onTick every few seconds while waiting so
 * the server can emit progress notifications. Resolves true when the job finished.
 */
export async function waitForJob(
  job: Job,
  waitSec: number,
  onTick?: (elapsedSec: number) => void,
  signal?: AbortSignal
): Promise<boolean> {
  if (job.status !== 'running') return true;
  if (waitSec <= 0) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (done: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
      resolve(done);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), waitSec * 1000);
    const ticker = setInterval(() => onTick?.(Math.round((Date.now() - job.startedAt) / 1000)), 5000);
    signal?.addEventListener('abort', onAbort);
    job.promise.then(() => finish(true));
  });
}

export function runningMessage(job: Job): ToolResult {
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  return {
    content: [
      {
        type: 'text',
        text:
          `[Job ${job.id} still running] ${job.tool}: ${job.summary} (elapsed ${elapsed}s)\n\n` +
          `The subagent keeps working in the background. Call get_delegation_result with ` +
          `job_id "${job.id}" to wait for and collect the result. Do not re-submit the task.`,
      },
    ],
  };
}

/** Test hook. */
export function clearJobs(): void {
  jobs.clear();
}
