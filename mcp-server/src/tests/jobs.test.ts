import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnProcess } from '../core/process.js';
import { EXIT_CODES } from '../core/types.js';
import { JobRegistry, jobRegistry, JobOutcome, JobSnapshot } from '../services/jobs/job-registry.js';
import { handleCancelJob, handleGetJobResult, handleGetJobStatus, getJobResultSchema } from '../tools/jobs.js';
import { createProgressReporter, dispatchJob } from '../tools/execution.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function json(response: { content: { text: string }[] }): JobSnapshot {
  return JSON.parse(response.content[0].text) as JobSnapshot;
}

describe('Async job registry and tools', () => {
  it('returns immediately, tracks agents and preserves an immutable running snapshot', async () => {
    const registry = new JobRegistry();
    const outcome = deferred<JobOutcome>();
    const dispatched = registry.start('delegate_task', async (_signal, onAgent) => {
      onAgent('codex'); onAgent('codex');
      return outcome.promise;
    });
    assert.equal(dispatched.status, 'running');
    assert.match(dispatched.job_id, /^[a-f0-9]{12}$/);
    await delay(0);
    const running = registry.get(dispatched.job_id)!;
    assert.deepEqual(running.usedAgents, ['codex']);
    running.usedAgents.push('mutated');
    outcome.resolve({ exitCode: 0, result: 'completed output', usedAgents: ['agy'] });
    const finished = await registry.wait(dispatched.job_id, 1);
    assert.equal(finished?.status, 'succeeded');
    assert.equal(finished?.result, 'completed output');
    assert.deepEqual(finished?.usedAgents, ['codex', 'agy']);
    assert.ok(finished?.finishedAt);
    assert.equal(dispatched.status, 'running');
    assert.deepEqual(dispatched.usedAgents, []);
  });

  it('classifies nonzero, timed out, cancelled and rejected jobs', async () => {
    const registry = new JobRegistry();
    for (const [exitCode, status] of [[1, 'failed'], [EXIT_CODES.TIMEOUT, 'timed_out'], [EXIT_CODES.CANCELLED, 'cancelled']] as const) {
      const job = registry.start('invoke_codex', async () => ({ exitCode, result: 'diagnostic' }));
      assert.equal((await registry.wait(job.job_id, 1))?.status, status);
    }
    const rejected = registry.start('invoke_agy', async () => { throw new Error('fake launch failed'); });
    const finished = await registry.wait(rejected.job_id, 1);
    assert.equal(finished?.status, 'failed');
    assert.equal(finished?.exitCode, EXIT_CODES.GENERIC_FAILURE);
    assert.equal(finished?.result, 'fake launch failed');
  });

  it('retains only the newest configured number of finished jobs and keeps running jobs', async () => {
    const registry = new JobRegistry(2);
    const pending = deferred<JobOutcome>();
    const running = registry.start('delegate_task', () => pending.promise);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = registry.start('invoke_codex', async () => ({ exitCode: 0, result: String(i) }));
      ids.push(job.job_id);
      await registry.wait(job.job_id, 1);
      await delay(3);
    }
    assert.equal(registry.get(ids[0]), undefined);
    assert.ok(registry.get(ids[1]));
    assert.ok(registry.get(ids[2]));
    assert.equal(registry.get(running.job_id)?.status, 'running');
    assert.equal(registry.list().length, 3);
    pending.resolve({ exitCode: 0, result: 'done' });
    await registry.wait(running.job_id, 1);
  });

  it('expires finished jobs by age without expiring running jobs', async () => {
    const registry = new JobRegistry(50, 20);
    const pending = deferred<JobOutcome>();
    const running = registry.start('delegate_task', () => pending.promise);
    const finished = registry.start('invoke_claude', async () => ({ exitCode: 0, result: 'done' }));
    await registry.wait(finished.job_id, 1);
    await delay(35);
    assert.equal(registry.get(finished.job_id), undefined);
    assert.equal(registry.get(running.job_id)?.status, 'running');
    pending.resolve({ exitCode: 0, result: 'done' });
    await registry.wait(running.job_id, 1);
  });

  it('retains the newest dispatched job when completion timestamps tie', async t => {
    const timestamp = new Date().toISOString();
    t.mock.method(Date.prototype, 'toISOString', () => timestamp);
    const registry = new JobRegistry(1);
    const first = registry.start('invoke_codex', async () => ({ exitCode: 0, result: 'first' }));
    await registry.wait(first.job_id, 1);
    const second = registry.start('invoke_codex', async () => ({ exitCode: 0, result: 'second' }));
    await registry.wait(second.job_id, 1);
    assert.equal(registry.get(first.job_id), undefined);
    assert.equal(registry.get(second.job_id)?.result, 'second');
  });

  it('get_job_result long polling returns as soon as the job completes', async () => {
    const registry = new JobRegistry();
    const pending = deferred<JobOutcome>();
    const job = registry.start('delegate_parallel', () => pending.promise);
    const response = handleGetJobResult({ job_id: job.job_id, wait_sec: 1 }, registry);
    setTimeout(() => pending.resolve({ exitCode: 0, result: 'polled result' }), 20);
    const started = Date.now();
    const result = json(await response);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result, 'polled result');
    assert.ok(Date.now() - started < 900, 'completion should wake the long poll');
  });

  it('get_job_result returns running when its wait expires and supports zero wait', async () => {
    const registry = new JobRegistry();
    const pending = deferred<JobOutcome>();
    const job = registry.start('delegate_task', () => pending.promise);
    assert.equal(json(await handleGetJobResult({ job_id: job.job_id, wait_sec: 0 }, registry)).status, 'running');
    const started = Date.now();
    assert.equal(json(await handleGetJobResult({ job_id: job.job_id, wait_sec: 0.02 }, registry)).status, 'running');
    assert.ok(Date.now() - started >= 15);
    pending.resolve({ exitCode: 0, result: 'done' });
    await registry.wait(job.job_id, 1);
  });

  it('status listings omit result text and missing jobs return tool errors', async () => {
    const registry = new JobRegistry();
    const job = registry.start('invoke_codex', async () => ({ exitCode: 0, result: 'large result' }));
    await registry.wait(job.job_id, 1);
    assert.equal(json(handleGetJobStatus({ job_id: job.job_id }, registry)).result, undefined);
    const listed = JSON.parse(handleGetJobStatus({}, registry).content[0].text) as JobSnapshot[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0].result, undefined);
    assert.equal(handleGetJobStatus({ job_id: 'missing' }, registry).isError, true);
    assert.equal((await handleGetJobResult({ job_id: 'missing', wait_sec: 0 }, registry)).isError, true);
    assert.equal((await handleCancelJob({ job_id: 'missing' }, registry)).isError, true);
    assert.equal(getJobResultSchema.parse({ job_id: 'id' }).wait_sec, 25);
    assert.equal(getJobResultSchema.safeParse({ job_id: 'id', wait_sec: 51 }).success, false);
  });

  it('abortAll cancels all running jobs and leaves finished jobs intact', async () => {
    const registry = new JobRegistry();
    const complete = registry.start('invoke_codex', async () => ({ exitCode: 0, result: 'done' }));
    await registry.wait(complete.job_id, 1);
    const run = (signal: AbortSignal) => new Promise<JobOutcome>(resolve => {
      const finish = () => resolve({ exitCode: EXIT_CODES.CANCELLED, result: 'cancelled' });
      if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
    });
    const jobs = [registry.start('delegate_task', run), registry.start('delegate_parallel', run)];
    await registry.abortAll();
    for (const job of jobs) assert.equal(registry.get(job.job_id)?.status, 'cancelled');
    assert.equal(registry.get(complete.job_id)?.status, 'succeeded');
    assert.equal((await registry.cancel(complete.job_id))?.status, 'succeeded');
  });

  it('cancel_job kills a running fake Node child and waits for termination', { timeout: 10000 }, async () => {
    const registry = new JobRegistry();
    const ready = deferred<number>();
    const originalDepth = process.env.AGENT_DELEGATION_DEPTH;
    // This test launches only process.execPath with a fixed fake script, never a CLI agent.
    process.env.AGENT_DELEGATION_DEPTH = '0';
    let readyTimer: NodeJS.Timeout | undefined;
    const job = registry.start('invoke_codex', async signal => {
      const result = await spawnProcess({ executable: process.execPath,
        args: ['-e', 'console.log(process.pid); setTimeout(()=>{},60000)'],
        signal, timeoutMs: 5000, onStdout: text => ready.resolve(Number(text.trim())) });
      return { exitCode: result.exitCode, result: result.stderr };
    });
    try {
      const pid = await Promise.race([ready.promise, new Promise<never>((_resolve, reject) => {
        readyTimer = setTimeout(() => reject(new Error('fake child did not start')), 4000);
      })]);
      process.kill(pid, 0);
      const cancelled = json(await handleCancelJob({ job_id: job.job_id }, registry));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.exitCode, EXIT_CODES.CANCELLED);
      assert.ok(cancelled.finishedAt);
      assert.throws(() => process.kill(pid, 0), 'child should be gone before cancellation returns');
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
      await registry.cancel(job.job_id);
      if (originalDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = originalDepth;
    }
  });

  it('dispatchJob preserves formatter output and structured timeout metadata', async () => {
    const response = dispatchJob('invoke_codex', async context => {
      assert.ok(context.signal);
      context.onProgress?.('codex');
      context.onResult?.({ exitCode: EXIT_CODES.TIMEOUT, usedAgent: 'codex' });
      return { isError: true, content: [{ type: 'text', text: 'timeout diagnostics' }] };
    });
    const job = json(response);
    assert.equal(job.status, 'running');
    const finished = await jobRegistry.wait(job.job_id, 1);
    assert.equal(finished?.status, 'timed_out');
    assert.equal(finished?.result, 'timeout diagnostics');
    assert.deepEqual(finished?.usedAgents, ['codex']);
  });
});

describe('Synchronous progress notifications', () => {
  it('throttles activity, emits quiet heartbeats and stops cleanly', async () => {
    const notifications: { method: string; params: { progressToken: string | number; progress: number; message: string } }[] = [];
    const reporter = createProgressReporter('token', async notification => { notifications.push(notification); }, 'delegate_task', 20, 1000);
    try {
      reporter.onProgress('codex'); reporter.onProgress('codex'); reporter.onProgress('agy');
      assert.equal(notifications.length, 1);
      await delay(65);
      assert.ok(notifications.length >= 3, 'quiet child should receive heartbeat notifications');
      assert.equal(notifications[0].method, 'notifications/progress');
      assert.equal(notifications[0].params.progressToken, 'token');
      assert.match(notifications[0].params.message, /codex: running for \d+s/);
      assert.match(notifications[1].params.message, /agy: running for \d+s/);
      assert.deepEqual(notifications.map(n => n.params.progress), notifications.map((_n, i) => i + 1));
    } finally { reporter.stop(); }
    const stoppedCount = notifications.length;
    await delay(30);
    assert.equal(notifications.length, stoppedCount);
  });

  it('emits no notifications when the host supplies no progress token', async () => {
    let sent = 0;
    const reporter = createProgressReporter(undefined, async () => { sent++; }, 'invoke_codex', 5, 1);
    reporter.onProgress('codex');
    await delay(20);
    reporter.stop();
    assert.equal(sent, 0);
  });
});
