import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MODELS, DEFAULT_SANDBOX, isExternalAgent, isWriteSandbox } from '../core/defaults.js';
import { invokeAgySchema, invokeCodexSchema, invokeClaudeSchema } from '../tools/invokers.js';
import { delegateTaskSchema, delegateParallelSchema } from '../tools/delegate.js';
import { invokeAgy } from '../services/invokers/agy-invoker.js';

describe('Delegation defaults policy', () => {
  describe('Configured models', () => {
    it('should default AGY to Gemini 3.8 Flash at medium effort', () => {
      assert.equal(DEFAULT_MODELS.agy.model, 'gemini-3.8-flash');
      assert.equal(DEFAULT_MODELS.agy.effort, 'medium');
    });

    it('should default Codex to GPT-6.1 Sol at medium effort', () => {
      assert.equal(DEFAULT_MODELS.codex.model, 'gpt-6.1-sol');
      assert.equal(DEFAULT_MODELS.codex.effort, 'medium');
    });

    it('should default Claude to Sonnet 5.5 at medium effort', () => {
      assert.equal(DEFAULT_MODELS.claude.model, 'claude-sonnet-5-5');
      assert.equal(DEFAULT_MODELS.claude.effort, 'medium');
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
      const script = path.join(tempDir, 'fake-agy.cjs');
      fs.writeFileSync(
        script,
        `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(0);`
      );
      const agyCmd = path.join(tempDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
      fs.writeFileSync(
        agyCmd,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { mode: 0o755 }
      );

      try {
        const res1 = await invokeAgy({
          prompt: 'test',
          model: 'Gemini 4 Argon (High)',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res1.exitCode, 0);
        const args1 = JSON.parse(res1.stdout) as string[];
        assert.equal(args1[args1.indexOf('--model') + 1], 'gemini-4-argon');
        assert.equal(args1[args1.indexOf('--effort') + 1], 'high');

        const res2 = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-argon-low',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res2.exitCode, 0);
        const args2 = JSON.parse(res2.stdout) as string[];
        assert.equal(args2[args2.indexOf('--model') + 1], 'gemini-4-argon');
        assert.equal(args2[args2.indexOf('--effort') + 1], 'low');

        const res3 = await invokeAgy({
          prompt: 'test',
          model: 'gemini-4-argon',
          workDir: tempDir,
          agyPath: agyCmd,
        });
        assert.equal(res3.exitCode, 0);
        const args3 = JSON.parse(res3.stdout) as string[];
        assert.equal(args3[args3.indexOf('--model') + 1], 'gemini-4-argon');
        assert.equal(args3[args3.indexOf('--effort') + 1], 'medium');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
