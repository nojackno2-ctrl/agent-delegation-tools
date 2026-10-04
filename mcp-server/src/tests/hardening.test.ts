import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_CODES } from '../core/types.js';
import { DEFAULT_MODELS } from '../core/defaults.js';
import { clearExecutableCache } from '../core/executables.js';
import { clearQuotaCache, getAgentQuota, evaluateProviderHealth } from '../services/quota/quota-service.js';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { handleDelegateTask, handleDelegateParallel, delegateParallelSchema, delegateTaskSchema } from '../tools/delegate.js';
import { handleInvokeAgy, handleInvokeCodex, handleInvokeClaude } from '../tools/invokers.js';
import { JobRegistry } from '../services/jobs/job-registry.js';
import { validateWorkDir } from '../utils/validation.js';
import { capOutputTail } from '../core/logging.js';

function makeFakeCli(dir: string, name: string, options: { stdout?: string; stderr?: string; exitCode?: number }): string {
  const script = path.join(dir, `${name}.cjs`);
  const stdoutStr = JSON.stringify(options.stdout ?? '');
  const stderrStr = JSON.stringify(options.stderr ?? '');
  const code = options.exitCode ?? 0;
  fs.writeFileSync(script, `
    if (${stdoutStr}) process.stdout.write(${stdoutStr} + '\\n');
    if (${stderrStr}) process.stderr.write(${stderrStr} + '\\n');
    process.exit(${code});
  `);
  const executable = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return executable;
}

describe('MCP Server Hardening Specification', () => {
  it('Item 11: Exported exit codes are unchanged and conform to spec', () => {
    assert.equal(EXIT_CODES.SUCCESS, 0);
    assert.equal(EXIT_CODES.GENERIC_FAILURE, 1);
    assert.equal(EXIT_CODES.QUOTA_EXCEEDED, 10);
    assert.equal(EXIT_CODES.ALL_DEPLETED, 75);
    assert.equal(EXIT_CODES.CONFIG_AUTH_ERROR, 78);
    assert.equal(EXIT_CODES.ENVIRONMENT_FAILURE, 79);
    assert.equal(EXIT_CODES.TIMEOUT, 124);
    assert.equal(EXIT_CODES.CANCELLED, 130);
  });

  it('Item 12: Package version is 1.1.0', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.version, '1.1.0');
  });

  it('Item 6: work_dir validation rejects missing, relative, non-existent, and non-directory paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-test-'));
    const tempFile = path.join(tempDir, 'a-file.txt');
    fs.writeFileSync(tempFile, 'hello');

    try {
      // 1. Missing / empty
      assert.equal(validateWorkDir('').valid, false);
      assert.equal(validateWorkDir(undefined).valid, false);

      // 2. Relative path
      const relResult = validateWorkDir('relative/path');
      assert.equal(relResult.valid, false);
      assert.match(relResult.error!, /must be an absolute path/);

      // 3. Non-existent path
      const nonExistent = path.join(tempDir, 'does-not-exist');
      const nonExResult = validateWorkDir(nonExistent);
      assert.equal(nonExResult.valid, false);
      assert.match(nonExResult.error!, /does not exist/);

      // 4. File instead of directory
      const fileResult = validateWorkDir(tempFile);
      assert.equal(fileResult.valid, false);
      assert.match(fileResult.error!, /is not a directory/);

      // 5. Valid existing directory
      const validResult = validateWorkDir(tempDir);
      assert.equal(validResult.valid, true);
      assert.equal(validResult.path, tempDir);

      // Handlers reject invalid work_dir immediately
      const invalidWorkDir = path.join(tempDir, 'not-there');
      const resDelegate = await handleDelegateTask({ prompt: 'test', work_dir: invalidWorkDir, async: false });
      assert.equal(resDelegate.isError, true);
      assert.match(resDelegate.content[0].text, /does not exist/);

      const resParallel = await handleDelegateParallel({ tasks: ['test'], work_dir: invalidWorkDir, async: false });
      assert.equal(resParallel.isError, true);
      assert.match(resParallel.content[0].text, /does not exist/);

      const resAgy = await handleInvokeAgy({ prompt: 'test', work_dir: invalidWorkDir, async: false });
      assert.equal(resAgy.isError, true);
      assert.match(resAgy.content[0].text, /does not exist/);

      const resCodex = await handleInvokeCodex({ prompt: 'test', work_dir: invalidWorkDir, async: false });
      assert.equal(resCodex.isError, true);
      assert.match(resCodex.content[0].text, /does not exist/);

      const resClaude = await handleInvokeClaude({ prompt: 'test', work_dir: invalidWorkDir, async: false });
      assert.equal(resClaude.isError, true);
      assert.match(resClaude.content[0].text, /does not exist/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Item 1 & 4: Failover attempt history records every attempt and delegate_task output includes attempts & logPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-test-'));
    const oldCodex = process.env.CODEX_CLI_PATH;
    const oldAgy = process.env.AGY_CLI_PATH;
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;

    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      // First attempt on codex fails with exit 10 (QUOTA_EXCEEDED) and stderr
      const codex = makeFakeCli(dir, 'codex', { stderr: 'Quota exceeded for codex account', exitCode: 10 });
      // Failover attempt on agy succeeds
      const agy = makeFakeCli(dir, 'agy', { stdout: 'Final answer from agy subagent', exitCode: 0 });

      process.env.CODEX_CLI_PATH = codex;
      process.env.AGY_CLI_PATH = agy;
      clearExecutableCache();
      clearQuotaCache();

      const result = await delegateTask({
        prompt: 'Solve task',
        agent: 'codex',
        fallbackAgent: 'agy',
        balanceQuota: false,
        workDir: dir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.usedAgent, 'agy');
      assert.equal(result.attempts?.length, 2);

      const [attempt1, attempt2] = result.attempts!;
      assert.equal(attempt1.agent, 'codex');
      assert.equal(attempt1.exitCode, 10);
      assert.match(attempt1.errorTail, /Quota exceeded for codex/);
      assert.ok(attempt1.durationMs >= 0);

      assert.equal(attempt2.agent, 'agy');
      assert.equal(attempt2.exitCode, 0);
      assert.ok(attempt2.durationMs >= 0);

      // Verify log file was written
      assert.ok(result.logPath);
      assert.ok(fs.existsSync(result.logPath!));
      const logContent = fs.readFileSync(result.logPath!, 'utf8');
      assert.match(logContent, /Final answer from agy subagent/);

      // Verify handleDelegateTask output includes Failover Attempts
      const response = await handleDelegateTask({
        prompt: 'Solve task',
        agent: 'codex',
        fallback_agent: 'agy',
        balance_quota: false,
        work_dir: dir,
        async: false,
      });

      assert.equal(response.isError, undefined);
      const text = response.content[0].text;
      assert.match(text, /Failover Attempts:/);
      assert.match(text, /codex.*Exit 10/);
      assert.match(text, /Final answer from agy subagent/);
      assert.match(text, /Log:/);
    } finally {
      if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
      if (oldAgy === undefined) delete process.env.AGY_CLI_PATH; else process.env.AGY_CLI_PATH = oldAgy;
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Item 2: CONFIG_AUTH_ERROR (78) marks provider unavailable in quota cache for TTL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-err-test-'));
    const oldCodex = process.env.CODEX_CLI_PATH;
    const oldAgy = process.env.AGY_CLI_PATH;
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    const oldAgyUsage = process.env.FAKE_AGY_CLI_USAGE_OUTPUT;

    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      process.env.FAKE_AGY_CLI_USAGE_OUTPUT = 'Gemini Models Weekly Limit Remaining 85% 2026-10-10T00:00:00Z\nGemini Models Five Hour Limit Remaining 85% 2026-10-04T05:00:00Z';
      const codex = makeFakeCli(dir, 'codex', { stderr: 'Auth token expired or config invalid', exitCode: 78 });
      const agy = makeFakeCli(dir, 'agy', { stdout: 'Agy success', exitCode: 0 });

      process.env.CODEX_CLI_PATH = codex;
      process.env.AGY_CLI_PATH = agy;
      clearExecutableCache();
      clearQuotaCache();

      const result = await delegateTask({
        prompt: 'Run test',
        agent: 'codex',
        fallbackAgent: 'agy',
        balanceQuota: false,
        workDir: dir,
      });

      assert.equal(result.usedAgent, 'agy');
      assert.equal(result.exitCode, 0);

      // Verify codex is now cached as unavailable
      const cached = await getAgentQuota('codex', { workDir: dir });
      assert.equal(cached.availability, 'unavailable');
      const health = evaluateProviderHealth(cached);
      assert.equal(health.available, false);

      // Next task with balanceQuota: true skips codex because it is cached as unavailable
      const result2 = await delegateTask({
        prompt: 'Run second task',
        agent: 'auto',
        taskType: 'implementation', // normally defaults primary to codex
        balanceQuota: true,
        workDir: dir,
      });

      // Because codex is marked unavailable in cache, it skipped to healthy external provider agy
      assert.equal(result2.usedAgent, 'agy');
      assert.equal(result2.exitCode, 0);
    } finally {
      if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
      if (oldAgy === undefined) delete process.env.AGY_CLI_PATH; else process.env.AGY_CLI_PATH = oldAgy;
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      if (oldAgyUsage === undefined) delete process.env.FAKE_AGY_CLI_USAGE_OUTPUT; else process.env.FAKE_AGY_CLI_USAGE_OUTPUT = oldAgyUsage;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Item 3: On failure, delegate_task returns both stderr and stdout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-out-test-'));
    const oldCodex = process.env.CODEX_CLI_PATH;
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;

    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const codex = makeFakeCli(dir, 'codex', {
        stdout: 'Standard output line explaining what happened',
        stderr: 'Standard error line showing failure trace',
        exitCode: 1,
      });

      process.env.CODEX_CLI_PATH = codex;
      clearExecutableCache();
      clearQuotaCache();

      const response = await handleDelegateTask({
        prompt: 'Failing task',
        agent: 'codex',
        fallback_agent: 'none',
        balance_quota: false,
        work_dir: dir,
        async: false,
      });

      assert.equal(response.isError, true);
      const text = response.content[0].text;
      assert.match(text, /Stdout:/);
      assert.match(text, /Standard output line explaining what happened/);
      assert.match(text, /Stderr:/);
      assert.match(text, /Standard error line showing failure trace/);
      assert.match(text, /Log:/);
    } finally {
      if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Item 4 & 5: delegate_parallel caps prompt to 120 chars, schema includes new fields, and results contain attempts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-test-'));
    const oldAgy = process.env.AGY_CLI_PATH;
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;

    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const agy = makeFakeCli(dir, 'agy', { stdout: 'Parallel worker output', exitCode: 0 });
      process.env.AGY_CLI_PATH = agy;
      clearExecutableCache();

      const longPrompt = 'A'.repeat(250);
      const results = await delegateParallel({
        tasks: [longPrompt],
        agent: 'agy',
        workDir: dir,
        timeoutSec: 10,
        balanceQuota: false,
        fallbackAgent: 'none',
        agyModel: 'gemini-3.8-flash',
        agyEffort: 'medium',
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].prompt.length, 120);
      assert.equal(results[0].prompt, 'A'.repeat(120));
      assert.ok(results[0].attempts);
      assert.equal(results[0].attempts?.length, 1);
      assert.ok(results[0].logPath);
      assert.match(results[0].output, /Parallel worker output/);

      // Verify delegateParallelSchema properties and description
      const schema = delegateParallelSchema.shape;
      assert.ok(schema.timeout_sec);
      assert.ok(schema.fallback_agent);
      assert.ok(schema.balance_quota);
      assert.ok(schema.agy_model);
      assert.ok(schema.agy_effort);
      assert.ok(schema.codex_model);
      assert.ok(schema.codex_effort);
      assert.ok(schema.claude_model);
      assert.ok(schema.claude_effort);
      assert.match(schema.agent.description || '', /round-robin across the external CLIs with per-task quota failover/);
    } finally {
      if (oldAgy === undefined) delete process.env.AGY_CLI_PATH; else process.env.AGY_CLI_PATH = oldAgy;
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH; else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Item 4: capOutputTail keeps the tail of long output', () => {
    const longText = 'HEADER_' + 'x'.repeat(25000) + '_TAIL_ANSWER';
    const capped = capOutputTail(longText, 20000, 'test.log');
    assert.match(capped, /_TAIL_ANSWER/);
    assert.match(capped, /Output truncated to last 20000 chars/);
    assert.ok(capped.length < 21000);
  });

  it('Item 7: cancel_job returns status cancelling if job does not settle within timeout', async () => {
    const registry = new JobRegistry();
    let resolveHanging!: () => void;
    const hangingPromise = new Promise<void>((r) => { resolveHanging = r; });

    const job = registry.start('delegate_task', async signal => {
      await hangingPromise;
      return { exitCode: signal.aborted ? EXIT_CODES.CANCELLED : 0, result: 'done' };
    });

    assert.equal(job.status, 'running');

    // Cancel with 50ms settle timeout
    const cancelling = await registry.cancel(job.job_id, 50);
    assert.ok(cancelling);
    assert.equal(cancelling?.status, 'cancelling');

    // When background job finally settles, status becomes cancelled
    resolveHanging();
    const settled = await registry.wait(job.job_id, 1);
    assert.equal(settled?.status, 'cancelled');
  });

  it('Item 8 & 9: Model/effort text generated from DEFAULT_MODELS and softened policy wording', async () => {
    assert.equal(DEFAULT_MODELS.agy.model, 'gemini-3.8-flash');
    assert.equal(DEFAULT_MODELS.agy.effort, 'medium');
    assert.equal(DEFAULT_MODELS.codex.model, 'gpt-6.1-sol');
    assert.equal(DEFAULT_MODELS.codex.effort, 'medium');
    assert.equal(DEFAULT_MODELS.claude.model, 'claude-sonnet-5-5');
    assert.equal(DEFAULT_MODELS.claude.effort, 'medium');

    // Descriptions in delegateTaskSchema interpolate DEFAULT_MODELS
    assert.match(delegateTaskSchema.shape.task_type.description || '', new RegExp(DEFAULT_MODELS.agy.model));
    assert.match(delegateTaskSchema.shape.task_type.description || '', new RegExp(DEFAULT_MODELS.codex.model));
  });

  it('Item 10: MCP tool annotations include readOnlyHint and destructiveHint', () => {
    const indexPath = fs.existsSync(new URL('../../src/index.ts', import.meta.url))
      ? new URL('../../src/index.ts', import.meta.url)
      : new URL('../index.js', import.meta.url);
    const indexSource = fs.readFileSync(indexPath, 'utf8');
    assert.match(indexSource, /readOnlyHint/);
    assert.match(indexSource, /destructiveHint/);
  });
});
