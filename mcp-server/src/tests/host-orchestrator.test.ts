import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  defaultAgentForTaskType,
  getExternalAgents,
  getHostAgent,
  isExternalAgent,
} from '../core/defaults.js';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { consultAdvisor, resetAdvisorConfig } from '../services/dispatcher/advisor-service.js';
import { clearQuotaCache } from '../services/quota/quota-service.js';
import { clearExecutableCache } from '../core/executables.js';
import { buildDelegationPolicy } from '../index.js';

const serverPath = fileURLToPath(new URL('../index.js', import.meta.url));

function makeFakeNodeCli(dir: string, name: string, scriptBody: string): string {
  const scriptPath = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');
  const binPath = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  const content =
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
  fs.writeFileSync(binPath, content, { mode: 0o755 });
  return binPath;
}

describe('Host-aware routing and AGY Orchestrator mode', () => {
  const envBackup: Record<string, string | undefined> = {};
  const watchedKeys = [
    'DELEGATION_HOST',
    'AGENT_DELEGATION_DEPTH',
    'CODEX_CLI_PATH',
    'CLAUDE_CLI_PATH',
    'AGY_CLI_PATH',
  ];

  beforeEach(() => {
    for (const k of watchedKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AGENT_DELEGATION_DEPTH = '0';
    clearExecutableCache();
    clearQuotaCache();
    resetAdvisorConfig();
  });

  afterEach(() => {
    for (const k of watchedKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    clearExecutableCache();
    clearQuotaCache();
    resetAdvisorConfig();
  });

  it('resolves host agent, external providers, and task-type defaults across hosts', () => {
    assert.equal(getHostAgent({}), 'claude');
    assert.equal(getHostAgent({ DELEGATION_HOST: 'AGY' }), 'agy');
    assert.equal(getHostAgent({ DELEGATION_HOST: 'codex' }), 'codex');
    assert.equal(getHostAgent({ DELEGATION_HOST: 'unknown' }), 'claude');

    assert.deepEqual(getExternalAgents('claude'), ['agy', 'codex']);
    assert.deepEqual(getExternalAgents('agy'), ['codex', 'claude']);
    assert.deepEqual(getExternalAgents('codex'), ['agy', 'claude']);

    assert.equal(isExternalAgent('codex', 'agy'), true);
    assert.equal(isExternalAgent('claude', 'agy'), true);
    assert.equal(isExternalAgent('agy', 'agy'), false);

    assert.equal(defaultAgentForTaskType('implementation', 'agy'), 'codex');
    assert.equal(defaultAgentForTaskType('scaffolding', 'agy'), 'codex');
    assert.equal(defaultAgentForTaskType('review', 'agy'), 'claude');
    assert.equal(defaultAgentForTaskType('analysis', 'agy'), 'claude');

    assert.equal(defaultAgentForTaskType('analysis', 'codex'), 'agy');
    assert.equal(defaultAgentForTaskType('implementation', 'codex'), 'claude');

    assert.equal(defaultAgentForTaskType('implementation', 'claude'), 'codex');
    assert.equal(defaultAgentForTaskType('analysis', 'claude'), 'agy');
  });

  it('routes delegateTask, delegateParallel, and consultAdvisor to Codex and Claude when DELEGATION_HOST=agy', async () => {
    process.env.DELEGATION_HOST = 'agy';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-host-route-'));
    try {
      process.env.CODEX_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-codex',
        `console.log('CODEX_OK');`
      );
      process.env.CLAUDE_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-claude',
        `let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
          console.log(JSON.stringify({ result: 'CLAUDE_OK' }));
        });`
      );

      const implRes = await delegateTask({
        prompt: 'Implement feature',
        taskType: 'implementation',
        agent: 'auto',
        balanceQuota: false,
        workDir: tempDir,
      });
      assert.equal(implRes.exitCode, 0);
      assert.equal(implRes.usedAgent, 'codex');
      assert.match(implRes.output || implRes.stdout, /CODEX_OK/);

      const reviewRes = await delegateTask({
        prompt: 'Review feature',
        taskType: 'review',
        agent: 'auto',
        balanceQuota: false,
        workDir: tempDir,
      });
      assert.equal(reviewRes.exitCode, 0);
      assert.equal(reviewRes.usedAgent, 'claude');
      assert.match(reviewRes.output || reviewRes.stdout, /CLAUDE_OK/);

      const parallelRes = await delegateParallel({
        tasks: ['Task 1', 'Task 2'],
        agent: 'auto',
        balanceQuota: false,
        workDir: tempDir,
      });
      assert.equal(parallelRes.length, 2);
      assert.equal(parallelRes[0].usedAgent, 'codex');
      assert.equal(parallelRes[1].usedAgent, 'claude');
      assert.equal(parallelRes[0].exitCode, 0);
      assert.equal(parallelRes[1].exitCode, 0);

      // Advisor auto mode under AGY: analysis -> claude (claude-opus-5-5 / max)
      const advisorRes = await consultAdvisor({
        question: 'Review architecture trade-offs',
        advisor: 'auto',
        balanceQuota: false,
        workDir: tempDir,
      });
      assert.equal(advisorRes.exitCode, 0);
      assert.equal(advisorRes.usedAgent, 'claude');
      assert.equal(advisorRes.advisorModel, 'claude-opus-5-5');
      assert.equal(advisorRes.advisorEffort, 'max');

      // When Claude is depleted, advisor fails over to Codex (not AGY)
      clearExecutableCache();
      process.env.CLAUDE_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-claude-depleted',
        `console.error('You have hit your rate limit'); process.exit(1);`
      );
      const failoverRes = await consultAdvisor({
        question: 'Need fallback advisor',
        advisor: 'auto',
        fallbackAgent: 'codex',
        balanceQuota: false,
        workDir: tempDir,
      });
      assert.equal(failoverRes.exitCode, 0);
      assert.equal(failoverRes.usedAgent, 'codex');
      assert.equal(failoverRes.advisorModel, 'gpt-6.2-astra');
      assert.equal(failoverRes.advisorEffort, 'max');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds AGY Orchestrator instructions and exposes Codex/Claude without host-quota warning over stdio MCP', async () => {
    const policy = buildDelegationPolicy('agy');
    assert.match(policy, /AGY Orchestrator Mode/);
    assert.match(policy, /codex, claude/);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { DELEGATION_HOST: 'agy', AGENT_DELEGATION_DEPTH: '0' });

    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
    const client = new Client({ name: 'agy-host-mcp-test', version: '1.0' });
    await client.connect(transport);
    try {
      const instructions = client.getInstructions() || '';
      assert.match(instructions, /AGY Orchestrator Mode/);
      assert.match(instructions, /Prefer the external CLIs \(codex, claude\)/);

      const tools = (await client.listTools()).tools;
      const invokeClaudeTool = tools.find(t => t.name === 'invoke_claude');
      const invokeAgyTool = tools.find(t => t.name === 'invoke_agy');
      assert.ok(invokeClaudeTool);
      assert.ok(invokeAgyTool);
      assert.doesNotMatch(invokeClaudeTool.description || '', /Last resort: it spends the same subscription quota/);
      assert.match(invokeAgyTool.description || '', /Last resort: it spends the same subscription quota/);
    } finally {
      await client.close();
    }
  });
});
