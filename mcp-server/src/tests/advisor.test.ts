import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ADVISOR_MODELS } from '../core/defaults.js';
import {
  buildAdvisorPrompt,
  consultAdvisor,
  getAdvisorConfig,
  resetAdvisorConfig,
  resolveAdvisorModels,
  setAdvisorConfig,
} from '../services/dispatcher/advisor-service.js';
import { handleConfigureAdvisor, handleConsultAdvisor } from '../tools/advisor.js';
import { clearQuotaCache } from '../services/quota/quota-service.js';
import { makeFakeAcpCli } from './helpers/fake-acp.js';

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

describe('Advisor Mode', () => {
  const envBackup: Record<string, string | undefined> = {};
  const watchedKeys = [
    'AGENT_DELEGATION_DEPTH',
    'AGY_CLI_PATH',
    'CODEX_CLI_PATH',
    'CLAUDE_CLI_PATH',
    'DELEGATION_ADVISOR',
    'DELEGATION_ADVISOR_MODEL',
    'DELEGATION_ADVISOR_EFFORT',
  ];

  beforeEach(() => {
    for (const k of watchedKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AGENT_DELEGATION_DEPTH = '0';
    clearQuotaCache();
    resetAdvisorConfig();
  });

  afterEach(() => {
    for (const k of watchedKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    clearQuotaCache();
    resetAdvisorConfig();
  });

  it('configures the strongest callable model and effort for all three providers', () => {
    assert.deepEqual(ADVISOR_MODELS.agy, { model: 'gemini-4-neon', effort: 'xhigh' });
    assert.deepEqual(ADVISOR_MODELS.codex, { model: 'gpt-6.2-astra', effort: 'max' });
    assert.deepEqual(ADVISOR_MODELS.claude, { model: 'claude-opus-5-5', effort: 'max' });
  });

  it('frames read-only advisor consultation prompt with question and context', () => {
    const prompt = buildAdvisorPrompt('How should we avoid the race condition?', 'Lock order A->B deadlocks.');
    assert.match(prompt, /\[Advisor Mode - Read-Only Consultation\]/);
    assert.match(prompt, /do NOT create, edit, or delete files/i);
    assert.match(prompt, /How should we avoid the race condition\?/);
    assert.match(prompt, /Lock order A->B deadlocks\./);
  });

  it('manages session advisor config and clears stale model overrides on provider switch', () => {
    assert.deepEqual(getAdvisorConfig(), { advisor: 'auto' });

    const setCodex = setAdvisorConfig({ advisor: 'codex', model: 'gpt-6.2-sol', effort: 'high' });
    assert.deepEqual(setCodex, { advisor: 'codex', model: 'gpt-6.2-sol', effort: 'high' });

    // Switching to agy without explicit model/effort must drop Codex-specific overrides
    const setAgy = setAdvisorConfig({ advisor: 'agy' });
    assert.deepEqual(setAgy, { advisor: 'agy' });
    assert.deepEqual(resolveAdvisorModels(setAgy.advisor, setAgy.model, setAgy.effort).agy, {
      model: 'gemini-4-neon',
      effort: 'xhigh',
    });

    const inspectRes = handleConfigureAdvisor({});
    const parsed = JSON.parse(inspectRes.content[0].text);
    assert.equal(parsed.active.advisor, 'agy');
    assert.deepEqual(parsed.strongest_defaults, ADVISOR_MODELS);

    const resetRes = handleConfigureAdvisor({ reset: true });
    const resetParsed = JSON.parse(resetRes.content[0].text);
    assert.equal(resetParsed.active.advisor, 'auto');
  });

  it('consults AGY advisor in read-only plan mode with gemini-4-neon-xhigh', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-agy-'));
    try {
      process.env.AGY_CLI_PATH = makeFakeAcpCli(tempDir, { echoState: true });

      const result = await consultAdvisor({
        question: 'Evaluate locking strategy',
        context: 'Seeing contention on hot path',
        advisor: 'agy',
        fallbackAgent: 'none',
        balanceQuota: false,
        workDir: tempDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.usedAgent, 'agy');
      assert.equal(result.advisorModel, 'gemini-4-neon');
      assert.equal(result.advisorEffort, 'xhigh');

      const state = JSON.parse(result.stdout);
      assert.equal(state.modelId, 'gemini-4-neon-xhigh');
      assert.equal(state.modeId, 'plan');
      const promptText = Array.isArray(state.prompt) ? state.prompt.map((p: any) => p.text).join('\n') : String(state.prompt);
      assert.match(promptText, /Evaluate locking strategy/);
      assert.match(promptText, /Seeing contention on hot path/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('consults Codex advisor in read-only sandbox with gpt-6.2-astra and max effort', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-codex-'));
    try {
      process.env.CODEX_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-codex',
        `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`
      );

      const res = await handleConsultAdvisor({
        async: false,
        question: 'Why does parser backtrack?',
        advisor: 'codex',
        fallback_agent: 'none',
        balance_quota: false,
        work_dir: tempDir,
      });

      assert.ok(!res.isError, res.content[0].text);
      assert.match(res.content[0].text, /\[Advisor: codex \(gpt-6\.2-astra \/ max\)\]/);
      const jsonLine = res.content[0].text.split('\n').find(l => l.trim().startsWith('{'))!;
      const payload = JSON.parse(jsonLine);
      assert.ok(payload.argv.includes('gpt-6.2-astra'));
      assert.ok(payload.argv.includes('model_reasoning_effort="max"'));
      assert.ok(payload.argv.includes('--sandbox'));
      assert.ok(payload.argv.includes('read-only'));
      assert.ok(!payload.argv.includes('--approve-for-me'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('consults Claude advisor in read-only plan mode with claude-opus-5-5 and max effort', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-claude-'));
    try {
      process.env.CLAUDE_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-claude',
        `let stdin = ''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
          console.log(JSON.stringify({ result: JSON.stringify({ argv: process.argv.slice(2), stdin }) }));
        });`
      );

      setAdvisorConfig({ advisor: 'claude', fallbackAgent: 'none' });
      const result = await consultAdvisor({
        question: 'Review auth state machine',
        balanceQuota: false,
        workDir: tempDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.usedAgent, 'claude');
      assert.equal(result.advisorModel, 'claude-opus-5-5');
      assert.equal(result.advisorEffort, 'max');

      const parsed = JSON.parse(result.output!);
      assert.ok(parsed.argv.includes('claude-opus-5-5'));
      assert.ok(parsed.argv.includes('max'));
      assert.ok(parsed.argv.includes('plan'));
      assert.match(parsed.stdin, /Review auth state machine/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails over from a depleted advisor to the next provider using its strongest model', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-failover-'));
    try {
      process.env.CODEX_CLI_PATH = makeFakeNodeCli(
        tempDir,
        'fake-codex-depleted',
        `console.error("ERROR: You've hit your usage limit."); process.exit(1);`
      );
      process.env.AGY_CLI_PATH = makeFakeAcpCli(tempDir, { echoState: true });

      const result = await consultAdvisor({
        question: 'Need fallback advice',
        advisor: 'codex',
        fallbackAgent: 'agy',
        balanceQuota: false,
        workDir: tempDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.usedAgent, 'agy');
      assert.equal(result.advisorModel, 'gemini-4-neon');
      assert.equal(result.advisorEffort, 'xhigh');
      assert.equal(result.attempts.length, 2);
      assert.equal(result.attempts[0].agent, 'codex');
      assert.equal(result.attempts[0].exitCode, 10);
      assert.equal(result.attempts[1].agent, 'agy');
      assert.equal(result.attempts[1].exitCode, 0);

      const state = JSON.parse(result.stdout);
      assert.equal(state.modelId, 'gemini-4-neon-xhigh');
      assert.equal(state.modeId, 'plan');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('advertises consult_advisor and configure_advisor over stdio MCP and runs async consultation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-mcp-'));
    const fakeCodex = makeFakeNodeCli(
      tempDir,
      'fake-codex-mcp',
      `console.log('ADVISOR_MCP_ADVICE_OK');`
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { CODEX_CLI_PATH: fakeCodex, AGENT_DELEGATION_DEPTH: '0' });

    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
    const client = new Client({ name: 'advisor-mcp-test', version: '1.0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools;
      const consultTool = tools.find(t => t.name === 'consult_advisor');
      const configTool = tools.find(t => t.name === 'configure_advisor');
      assert.ok(consultTool, 'consult_advisor must be listed');
      assert.ok(configTool, 'configure_advisor must be listed');
      assert.equal((consultTool as any).annotations?.readOnlyHint, true);

      const cfgRes = await client.callTool({
        name: 'configure_advisor',
        arguments: { advisor: 'codex', fallback_agent: 'none' },
      });
      const cfgJson = JSON.parse((cfgRes.content as any)[0].text);
      assert.equal(cfgJson.active.advisor, 'codex');
      assert.equal(cfgJson.strongest_defaults.codex.model, 'gpt-6.2-astra');

      const dispatched = await client.callTool({
        name: 'consult_advisor',
        arguments: { question: 'Check cache invalidation', balance_quota: false, work_dir: tempDir },
      });
      const job = JSON.parse((dispatched.content as any)[0].text);
      assert.equal(job.status, 'running');
      assert.ok(job.job_id);

      const done = await client.callTool({
        name: 'get_job_result',
        arguments: { job_id: job.job_id, wait_sec: 10 },
      });
      const doneJson = JSON.parse((done.content as any)[0].text);
      assert.equal(doneJson.status, 'succeeded');
      assert.match(doneJson.result, /\[Advisor: codex \(gpt-6\.2-astra \/ max\)\]/);
      assert.match(doneJson.result, /ADVISOR_MCP_ADVICE_OK/);
    } finally {
      await client.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
