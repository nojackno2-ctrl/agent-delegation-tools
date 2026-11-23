import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MODELS, DEFAULT_SANDBOX, isExternalAgent, isWriteSandbox } from '../core/defaults.js';
import { invokeAgySchema, invokeCodexSchema, invokeClaudeSchema } from '../tools/invokers.js';
import { delegateTaskSchema, delegateParallelSchema } from '../tools/delegate.js';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { makeFakeAcpCli } from './helpers/fake-acp.js';

describe('Delegation defaults policy', () => {
  describe('Configured models', () => {
    it('should default AGY to Gemini 4 Hydrogen at low effort', () => {
      assert.equal(DEFAULT_MODELS.agy.model, 'gemini-4-hydrogen');
      assert.equal(DEFAULT_MODELS.agy.effort, 'low');
    });

    it('should default Codex to GPT-6.1 Terra at low effort', () => {
      assert.equal(DEFAULT_MODELS.codex.model, 'gpt-6.1-terra');
      assert.equal(DEFAULT_MODELS.codex.effort, 'low');
    });

    it('should default Claude to Sonnet 5.5 at low effort', () => {
      assert.equal(DEFAULT_MODELS.claude.model, 'claude-sonnet-5-5');
      assert.equal(DEFAULT_MODELS.claude.effort, 'low');
    });
  });

  describe('Provider classification', () => {
    it('should treat only AGY and Codex as external providers', () => {
      assert.equal(isExternalAgent('agy'), true);
      assert.equal(isExternalAgent('codex'), true);
      assert.equal(isExternalAgent('claude'), false);
    });

    it('should recognize write-capable sandboxes', () => {
      assert.equal(isWriteSandbox('workspace-write'), true);
      assert.equal(isWriteSandbox('danger-full-access'), true);
      assert.equal(isWriteSandbox('read-only'), false);
      assert.equal(isWriteSandbox(undefined), false);
    });
  });

  describe('Tool schema defaults', () => {
    it('should delegate write-capable and implementation-routed by default', () => {
      const parsed = delegateTaskSchema.parse({ prompt: 'do the thing', work_dir: process.cwd() });
      assert.equal(parsed.sandbox, DEFAULT_SANDBOX);
      assert.equal(parsed.sandbox, 'workspace-write');
      assert.equal(parsed.task_type, 'implementation');
      assert.equal(parsed.agent, 'auto');
      assert.equal(parsed.balance_quota, true);
      assert.equal(parsed.work_dir, process.cwd());
    });

    it('should keep parallel batches write-capable', () => {
      const parsed = delegateParallelSchema.parse({ tasks: ['a', 'b'], work_dir: process.cwd() });
      assert.equal(parsed.sandbox, 'workspace-write');
      assert.equal(parsed.agent, 'auto');
      assert.equal(parsed.work_dir, process.cwd());
    });

    it('should apply the configured model and effort per invoker', () => {
      const agy = invokeAgySchema.parse({ prompt: 'x', work_dir: process.cwd() });
      assert.equal(agy.model, DEFAULT_MODELS.agy.model);
      assert.equal(agy.effort, DEFAULT_MODELS.agy.effort);
      assert.equal(agy.mode, 'accept-edits');
      assert.equal(agy.work_dir, process.cwd());

      const codex = invokeCodexSchema.parse({ prompt: 'x', work_dir: process.cwd() });
      assert.equal(codex.model, DEFAULT_MODELS.codex.model);
      assert.equal(codex.effort, DEFAULT_MODELS.codex.effort);
      assert.equal(codex.sandbox, 'workspace-write');
      assert.equal(codex.work_dir, process.cwd());

      const claude = invokeClaudeSchema.parse({ prompt: 'x', work_dir: process.cwd() });
      assert.equal(claude.model, DEFAULT_MODELS.claude.model);
      assert.equal(claude.effort, DEFAULT_MODELS.claude.effort);
      assert.equal(claude.mode, 'workspace-write');
      assert.equal(claude.work_dir, process.cwd());
    });

    it('should still honour an explicit override', () => {
      const parsed = invokeAgySchema.parse({ prompt: 'x', model: 'gemini-4-argon', effort: 'low', work_dir: process.cwd() });
      assert.equal(parsed.model, 'gemini-4-argon');
      assert.equal(parsed.effort, 'low');
      assert.equal(parsed.work_dir, process.cwd());
    });

    it('should normalize Gemini 4 Argon and Gemini 3.8 Flash aliases in invokeAgy', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-test-'));
      const agyCmd = makeFakeAcpCli(tempDir, { echoState: true });

      try {
        const res1 = await invokeAgy({
          prompt: 'test',
          model: 'Gemini 4 Argon (High)',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res1.exitCode, 0);
        const state1 = JSON.parse(res1.stdout);
        assert.equal(state1.argv[0], 'acp');
        assert.equal(state1.modelId, 'gemini-4-argon-high');

        const res2 = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-argon-low',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res2.exitCode, 0);
        const state2 = JSON.parse(res2.stdout);
        assert.equal(state2.modelId, 'gemini-4-argon-low');

        const res3 = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-argon',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res3.exitCode, 0);
        const state3 = JSON.parse(res3.stdout);
        assert.equal(state3.modelId, 'gemini-4-argon-low');

        const fixed = await invokeAgy({ prompt: 'test', model: 'gpt-oss-120b-medium', effort: 'high', workDir: tempDir, agyPath: agyCmd });
        assert.equal(fixed.exitCode, 0);
        const fixedState = JSON.parse(fixed.stdout);
        assert.equal(fixedState.modelId, 'gpt-oss-120b-medium');

        const hydroHuman = await invokeAgy({
          prompt: 'test',
          model: 'Gemini 4 Hydrogen (XHigh)',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(hydroHuman.exitCode, 0);
        const hydroHumanState = JSON.parse(hydroHuman.stdout);
        assert.equal(hydroHumanState.modelId, 'gemini-4-hydrogen-xhigh');

        const hydroAuto = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-hydrogen',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(hydroAuto.exitCode, 0);
        const hydroAutoState = JSON.parse(hydroAuto.stdout);
        assert.equal(hydroAutoState.modelId, 'gemini-4-hydrogen-low');

        const orch = await invokeAgy({
          prompt: 'test',
          model: 'Orchestrator (Argon)',
          effort: 'high',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(orch.exitCode, 0);
        const orchState = JSON.parse(orch.stdout);
        assert.equal(orchState.modelId, 'gemini-pro-orchestrator-g1-pro');

        const neonHuman = await invokeAgy({
          prompt: 'test',
          model: 'Gemini 4 Neon (XHigh)',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(neonHuman.exitCode, 0);
        const neonHumanState = JSON.parse(neonHuman.stdout);
        assert.equal(neonHumanState.modelId, 'gemini-4-neon-xhigh');

        const neonAuto = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-neon',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(neonAuto.exitCode, 0);
        const neonAutoState = JSON.parse(neonAuto.stdout);
        assert.equal(neonAutoState.modelId, 'gemini-4-neon-low');

        const orchNeon = await invokeAgy({
          prompt: 'test',
          model: 'Orchestrator (Neon)',
          effort: 'high',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(orchNeon.exitCode, 0);
        const orchNeonState = JSON.parse(orchNeon.stdout);
        assert.equal(orchNeonState.modelId, 'gemini-pro-orchestrator-neon');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
