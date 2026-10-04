import { randomBytes } from 'node:crypto';
import { EXIT_CODES, DelegationAttempt } from '../../core/types.js';

export type JobStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface JobOutcome {
  exitCode: number;
  result: string;
  usedAgents?: string[];
  attempts?: DelegationAttempt[];
  logPath?: string;
}

export interface JobSnapshot {
  job_id: string;
  kind: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  usedAgents: string[];
  exitCode?: number;
  result?: string;
  attempts?: DelegationAttempt[];
  logPath?: string;
}

interface Job {
  snapshot: JobSnapshot;
  controller: AbortController;
  done: Promise<void>;
}

/** Running jobs never expire; completed jobs are bounded by age and count. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly maxFinished = 50, private readonly retentionMs = 3600000) {}

  private prune() {
    const finished = [...this.jobs.values()].reverse().filter(j => j.snapshot.finishedAt)
      .sort((a, b) => Date.parse(b.snapshot.finishedAt!) - Date.parse(a.snapshot.finishedAt!));
    for (const [index, job] of finished.entries()) {
      if (index >= this.maxFinished || Date.now() - Date.parse(job.snapshot.finishedAt!) >= this.retentionMs) {
        this.jobs.delete(job.snapshot.job_id);
      }
    }
  }

  start(kind: string, run: (signal: AbortSignal, onAgent: (agent: string) => void) => Promise<JobOutcome>): JobSnapshot {
    this.prune();
    let id: string;
    do { id = randomBytes(6).toString('hex'); } while (this.jobs.has(id));
    const job: Job = {
      snapshot: { job_id: id, kind, status: 'running', startedAt: new Date().toISOString(), usedAgents: [] },
      controller: new AbortController(), done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    const dispatched = this.copy(job);
    job.done = Promise.resolve().then(() => run(job.controller.signal, agent => {
      if (!job.snapshot.usedAgents.includes(agent)) job.snapshot.usedAgents.push(agent);
    })).then(outcome => {
      Object.assign(job.snapshot, {
        exitCode: job.controller.signal.aborted ? EXIT_CODES.CANCELLED : outcome.exitCode,
        result: outcome.result,
        attempts: outcome.attempts,
        logPath: outcome.logPath,
      });
      if (outcome.usedAgents) job.snapshot.usedAgents = [...new Set([...job.snapshot.usedAgents, ...outcome.usedAgents])];
      job.snapshot.status = job.controller.signal.aborted || outcome.exitCode === EXIT_CODES.CANCELLED ? 'cancelled'
        : outcome.exitCode === EXIT_CODES.TIMEOUT ? 'timed_out' : outcome.exitCode === 0 ? 'succeeded' : 'failed';
    }, error => {
      job.snapshot.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.snapshot.exitCode = job.controller.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.GENERIC_FAILURE;
      job.snapshot.result = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      job.snapshot.finishedAt = new Date().toISOString();
      this.prune();
    });
    return dispatched;
  }

  private copy(job: Job): JobSnapshot {
    return {
      ...job.snapshot,
      usedAgents: [...job.snapshot.usedAgents],
      attempts: job.snapshot.attempts ? [...job.snapshot.attempts] : undefined,
    };
  }

  get(id: string): JobSnapshot | undefined { this.prune(); const job = this.jobs.get(id); return job && this.copy(job); }
  list(): JobSnapshot[] { this.prune(); return [...this.jobs.values()].map(job => this.copy(job)); }

  async wait(id: string, waitSec = 25): Promise<JobSnapshot | undefined> {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if ((job.snapshot.status === 'running' || job.snapshot.status === 'cancelling') && waitSec > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(50, waitSec) * 1000); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.copy(job);
  }

  async cancel(id: string, settleTimeoutMs = 5000): Promise<JobSnapshot | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.snapshot.status === 'running' || job.snapshot.status === 'cancelling') {
      if (job.snapshot.status === 'running') {
        job.controller.abort();
      }
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), settleTimeoutMs);
      });
      try {
        const race = await Promise.race([
          job.done.then(() => 'done' as const),
          timeoutPromise,
        ]);
        if (race === 'timeout' && (job.snapshot.status === 'running' || job.snapshot.status === 'cancelling')) {
          job.snapshot.status = 'cancelling';
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return this.copy(job);
  }

  async abortAll(settleTimeoutMs = 5000): Promise<void> {
    const running = [...this.jobs.values()].filter(job => job.snapshot.status === 'running' || job.snapshot.status === 'cancelling');
    for (const job of running) job.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, settleTimeoutMs); });
    try {
      await Promise.race([Promise.all(running.map(job => job.done)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const jobRegistry = new JobRegistry();
