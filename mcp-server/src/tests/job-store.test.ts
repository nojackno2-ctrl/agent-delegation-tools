import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startJob,
  getJob,
  listJobs,
  waitForJob,
  clampWaitSec,
  runningMessage,
  clearJobs,
  DEFAULT_WAIT_SEC,
  MAX_WAIT_SEC,
  ToolResult,
} from '../services/jobs/job-store.js';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Delegation job store', () => {
  beforeEach(() => clearJobs());

  it('returns the result inline when the job finishes within the wait', async () => {
    const job = startJob('delegate_task', 'fast', async () => ok('done'));
    assert.equal(await waitForJob(job, 1), true);
    assert.equal(job.status, 'completed');
    assert.equal(job.result?.content[0].text, 'done');
  });

  it('reports still running after the wait and keeps the job collectable', async () => {
    const job = startJob('delegate_task', 'slow', async () => {
      await sleep(300);
      return ok('late');
    });
    assert.equal(await waitForJob(job, 0.05), false);
    assert.equal(job.status, 'running');
    assert.match(runningMessage(job).content[0].text, new RegExp(`get_delegation_result.*${job.id}`, 's'));

    assert.equal(getJob(job.id), job);
    assert.equal(await waitForJob(job, 2), true);
    assert.equal(job.result?.content[0].text, 'late');
  });

  it('marks isError results and thrown errors as failed', async () => {
    const errored = startJob('invoke_agy', 'err', async () => ({ ...ok('bad'), isError: true }));
    const thrown = startJob('invoke_agy', 'throw', async () => {
      throw new Error('boom');
    });
    await Promise.all([errored.promise, thrown.promise]);
    assert.equal(errored.status, 'failed');
    assert.equal(thrown.status, 'failed');
    assert.match(thrown.result!.content[0].text, /boom/);
    assert.equal(listJobs().length, 2);
  });

  it('stops waiting when the request is aborted', async () => {
    const job = startJob('delegate_task', 'abort', () => sleep(1000).then(() => ok('x')));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    assert.equal(await waitForJob(job, 5, undefined, controller.signal), false);
  });

  it('clamps wait_sec below the client request timeout', () => {
    assert.equal(clampWaitSec(undefined), DEFAULT_WAIT_SEC);
    assert.equal(clampWaitSec(999), MAX_WAIT_SEC);
    assert.equal(clampWaitSec(-3), 0);
    assert.ok(MAX_WAIT_SEC < 60);
  });
});
