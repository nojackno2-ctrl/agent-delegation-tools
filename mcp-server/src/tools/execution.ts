import { EXIT_CODES, DelegationAttempt } from '../core/types.js';
import { jobRegistry } from '../services/jobs/job-registry.js';

export interface ResultPayload {
  exitCode: number;
  usedAgent?: string;
  attempts?: DelegationAttempt[];
  logPath?: string;
}

export interface ToolContext {
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
  onResult?: (result: ResultPayload | ResultPayload[]) => void;
}
export interface ToolResponse { [key: string]: unknown; isError?: boolean; content: { type: 'text'; text: string }[] }

/** Reuses the synchronous formatter so async results retain the same diagnostics. */
export function dispatchJob(kind: string, run: (context: ToolContext) => Promise<ToolResponse>): ToolResponse {
  const job = jobRegistry.start(kind, async (signal, onProgress) => {
    let exitCode: number | undefined;
    const usedAgents: string[] = [];
    const allAttempts: DelegationAttempt[] = [];
    let logPath: string | undefined;
    const response = await run({ signal, onProgress, onResult: result => {
      const results = Array.isArray(result) ? result : [result];
      exitCode = results.find(r => r.exitCode === EXIT_CODES.CANCELLED)?.exitCode
        ?? results.find(r => r.exitCode === EXIT_CODES.TIMEOUT)?.exitCode
        ?? results.find(r => r.exitCode !== 0)?.exitCode ?? 0;
      for (const r of results) {
        if (r.usedAgent) usedAgents.push(r.usedAgent);
        if (r.attempts) allAttempts.push(...r.attempts);
        if (r.logPath && !logPath) logPath = r.logPath;
      }
    } });
    return {
      exitCode: exitCode ?? (response.isError ? EXIT_CODES.GENERIC_FAILURE : 0),
      usedAgents,
      attempts: allAttempts.length > 0 ? allAttempts : undefined,
      logPath,
      result: response.content.map(item => item.text).join('\n'),
    };
  });
  return { content: [{ type: 'text', text: JSON.stringify({ job_id: job.job_id, status: 'running', hint: 'Poll get_job_result with job_id until finished; cancel_job stops the child process tree.' }) }] };
}

/** Activity notifications are throttled; heartbeat continues during quiet children. */
export function createProgressReporter(token: string | number | undefined,
  send: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>,
  label: string, heartbeatMs = 15000, throttleMs = 5000) {
  const started = Date.now();
  let lastSent = -Infinity;
  let agent = label;
  let progress = 0;
  const emit = (force = false) => {
    if (token === undefined || (!force && Date.now() - lastSent < throttleMs)) return;
    lastSent = Date.now();
    void send({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress,
      message: `${agent}: running for ${Math.floor((Date.now() - started) / 1000)}s` } }).catch(() => {});
  };
  const timer = token === undefined ? undefined : setInterval(() => emit(true), heartbeatMs);
  timer?.unref();
  return { onProgress: (name: string) => { agent = name; emit(); }, stop: () => { if (timer) clearInterval(timer); } };
}
