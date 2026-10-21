import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isQuotaExhausted } from '../core/quota-signals.js';
import { invokeCodex } from '../services/invokers/codex-invoker.js';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { clearExecutableCache } from '../core/executables.js';
import { EXIT_CODES } from '../core/types.js';
import { clearQuotaCache, getAgentQuota } from '../services/quota/quota-service.js';

const CODEX_LIMIT = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 10:00 AM.';
const AGY_CREDITS = 'error: Your AI credits balance is too low to continue.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)","status":"RESOURCE_EXHAUSTED"}';

function fakeCli(dir: string, name: string, text: string, exitCode: number): string {
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `console.error(${JSON.stringify(text)}); process.exit(${exitCode});`);
  const executable = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}"\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${script}"\n`, { mode: 0o755 });
  return executable;
}

test('quota signatures cover real Codex and AGY exhaustion messages', () => {
  for (const text of [CODEX_LIMIT, "You've hit your usage limit", AGY_CREDITS, 'Your AI credits balance is too low', 'insufficient_quota', 'HTTP 429']) {
    assert.equal(isQuotaExhausted(text), true, text);
  }
  for (const text of ['Task failed: a test assertion did not pass', 'listening on port 4290', 'no credit card required']) {
    assert.equal(isQuotaExhausted(text), false, text);
  }
});

test('Codex/AGY non-zero quota exits map to Exit 10 and fail over; zero exits are untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-quota-fake-'));
  const saved = { codex: process.env.CODEX_CLI_PATH, agy: process.env.AGY_CLI_PATH, depth: process.env.AGENT_DELEGATION_DEPTH };
  try {
    const codex = fakeCli(dir, 'codex', CODEX_LIMIT, 1);
    const agyDepleted = fakeCli(dir, 'agy-depleted', AGY_CREDITS, 3);
    assert.equal((await invokeCodex({ prompt: 'fake only', codexPath: codex, workDir: dir })).exitCode, EXIT_CODES.QUOTA_EXCEEDED);
    assert.equal((await invokeAgy({ prompt: 'fake only', agyPath: agyDepleted, workDir: dir })).exitCode, EXIT_CODES.QUOTA_EXCEEDED);
    // A successful run that merely quotes the message (e.g. read from a handoff file) stays a success.
    const quoting = fakeCli(dir, 'codex-quoting', CODEX_LIMIT, 0);
    assert.equal((await invokeCodex({ prompt: 'fake only', codexPath: quoting, workDir: dir })).exitCode, EXIT_CODES.SUCCESS);

    process.env.CODEX_CLI_PATH = codex;
    process.env.AGY_CLI_PATH = fakeCli(dir, 'agy', 'fallback success', 0);
    process.env.AGENT_DELEGATION_DEPTH = '0';
    clearExecutableCache();
    clearQuotaCache();
    const result = await delegateTask({ prompt: 'fake only', agent: 'codex', fallbackAgent: 'agy', balanceQuota: false, workDir: dir });
    assert.equal(result.usedAgent, 'agy');
    assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
    assert.deepEqual(result.attempts.map(a => [a.agent, a.exitCode]), [['codex', EXIT_CODES.QUOTA_EXCEEDED], ['agy', 0]]);
    assert.equal((await getAgentQuota('codex')).availability, 'depleted');
  } finally {
    for (const [key, value] of [['CODEX_CLI_PATH', saved.codex], ['AGY_CLI_PATH', saved.agy], ['AGENT_DELEGATION_DEPTH', saved.depth]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    clearExecutableCache();
    clearQuotaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
