import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invokeCodex, isCodexEnvironmentFailure } from '../services/invokers/codex-invoker.js';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { clearExecutableCache } from '../core/executables.js';
import { EXIT_CODES } from '../core/types.js';
import { clearQuotaCache, getAgentQuota } from '../services/quota/quota-service.js';

function fakeCli(dir: string, name: string, text: string): string {
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `console.log(${JSON.stringify(text)});`);
  const executable = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}"\r\nexit /b 0\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${script}"\n`, { mode: 0o755 });
  return executable;
}

test('Codex fake zero exit startup failures fail over without quota depletion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-fake-'));
  const oldCodex = process.env.CODEX_CLI_PATH;
  const oldAgy = process.env.AGY_CLI_PATH;
  const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
  try {
    const codex = fakeCli(dir, 'codex', 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors');
    const agy = fakeCli(dir, 'agy', 'fallback success');
    process.env.CODEX_CLI_PATH = codex;
    process.env.AGENT_DELEGATION_DEPTH = '0';
    process.env.AGY_CLI_PATH = agy;
    clearExecutableCache();
    clearQuotaCache();
    // Populate a cache entry using only the fake CLI (never a real provider).
    const cachedQuota = await getAgentQuota('codex', { codexPath: codex, timeoutSec: 1, workDir: dir });
    const activity: string[] = [];
    const invocation = await invokeCodex({ prompt: 'fake only', codexPath: codex, workDir: dir, onProgress: (agent) => activity.push(agent) });
    assert.equal(invocation.exitCode, EXIT_CODES.ENVIRONMENT_FAILURE);
    assert.ok(activity.includes('codex'));
    const result = await delegateTask({ prompt: 'fake only', agent: 'codex', fallbackAgent: 'agy', balanceQuota: false, workDir: dir });
    assert.equal(result.usedAgent, 'agy');
    assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
    assert.equal(result.output, 'fallback success');
    assert.equal(await getAgentQuota('codex'), cachedQuota);
    assert.notEqual(cachedQuota.availability, 'depleted');
    // An environment failure leaves quota cache unmarked; a subsequent explicit
    // dispatch still executes the same backend and reports its environment error.
    const retry = await delegateTask({ prompt: 'fake only', agent: 'codex', balanceQuota: false, workDir: dir });
    assert.equal(retry.exitCode, EXIT_CODES.ENVIRONMENT_FAILURE);
    for (const [index, pattern] of ['helper_unknown_error', 'setup refresh had errors', 'Failed to create unified exec process', 'windows sandbox failed'].entries()) {
      const failing = fakeCli(dir, `failure-${index}`, pattern);
      assert.equal((await invokeCodex({ prompt: 'fake only', codexPath: failing, workDir: dir })).exitCode, EXIT_CODES.ENVIRONMENT_FAILURE);
    }
    const ordinary = fakeCli(dir, 'ordinary', 'Task failed: a test assertion did not pass');
    assert.equal((await invokeCodex({ prompt: 'fake only', codexPath: ordinary, workDir: dir })).exitCode, EXIT_CODES.SUCCESS);
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
    if (oldAgy === undefined) delete process.env.AGY_CLI_PATH; else process.env.AGY_CLI_PATH = oldAgy;
    if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
    clearExecutableCache();
    clearQuotaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback_agent none pins the run to the primary even with quota balancing on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-fake-'));
  const oldCodex = process.env.CODEX_CLI_PATH;
  const oldAgy = process.env.AGY_CLI_PATH;
  const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
  try {
    // The fake codex cannot answer a quota query, so balancing would mark it
    // unavailable and promote agy; pinning must skip that entirely.
    process.env.CODEX_CLI_PATH = fakeCli(dir, 'codex', 'pinned codex result');
    process.env.AGY_CLI_PATH = fakeCli(dir, 'agy', 'agy should not run');
    process.env.AGENT_DELEGATION_DEPTH = '0';
    clearExecutableCache();
    clearQuotaCache();
    const result = await delegateTask({ prompt: 'fake only', agent: 'codex', fallbackAgent: 'none', balanceQuota: true, workDir: dir });
    assert.equal(result.usedAgent, 'codex');
    assert.equal(result.output, 'pinned codex result');
    assert.deepEqual((result.attempts ?? []).map((attempt) => attempt.agent), ['codex']);
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
    if (oldAgy === undefined) delete process.env.AGY_CLI_PATH; else process.env.AGY_CLI_PATH = oldAgy;
    if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
    clearExecutableCache();
    clearQuotaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('environment-failure detection ignores signatures quoted in task output', () => {
  const realFailure = [
    'exec',
    '"powershell.exe" -Command Get-Location in D:\\repo',
    ' exited -1 in 0ms:',
    'Failed to create unified exec process: helper_unknown_error: setup refresh had errors',
    '2026-10-03T16:07:25Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\\")" }',
  ].join('\n');
  assert.equal(isCodexEnvironmentFailure(realFailure), true);
  // A successful run that printed a handoff note quoting the same strings.
  const quoted = [
    'exec',
    '"powershell.exe" -Command Get-Content AI_HANDOFF.md in D:\\repo',
    ' succeeded in 120ms:',
    '- Codex failed with `helper_unknown_error: setup refresh had errors` before the ownership fix.',
    'Failed to create unified exec process: helper_unknown_error: setup refresh had errors',
  ].join('\n');
  assert.equal(isCodexEnvironmentFailure(quoted), false);
  assert.equal(isCodexEnvironmentFailure('Notes mention helper_unknown_error inline only.'), false);
});

test('cancelled dispatcher and parallel batch never pick another task', async () => {
  const controller = new AbortController();
  controller.abort();
  const options = { signal: controller.signal, agent: 'codex' as const };
  assert.equal((await delegateTask({ ...options, prompt: 'never run', fallbackAgent: 'agy' })).exitCode, EXIT_CODES.CANCELLED);
  const results = await delegateParallel({ ...options, tasks: ['never run', 'also never run'] });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.exitCode === EXIT_CODES.CANCELLED));
});
