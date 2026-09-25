import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODELS, DEFAULT_SANDBOX, isExternalAgent, isWriteSandbox } from '../core/defaults.js';
import { invokeAgySchema, invokeCodexSchema, invokeClaudeSchema } from '../tools/invokers.js';
import { delegateTaskSchema, delegateParallelSchema } from '../tools/delegate.js';

describe('Delegation defaults policy', () => {
  describe('Configured models', () => {
    it('should default AGY to Gemini 3.8 Flash at medium effort', () => {
      assert.equal(DEFAULT_MODELS.agy.model, 'gemini-3.8-flash');
      assert.equal(DEFAULT_MODELS.agy.effort, 'medium');
    });

    it('should default Codex to GPT-6-Luna at medium effort', () => {
      assert.equal(DEFAULT_MODELS.codex.model, 'gpt-6-luna');
      assert.equal(DEFAULT_MODELS.codex.effort, 'medium');
    });

    it('should default Claude to Sonnet 5 at medium effort', () => {
      assert.equal(DEFAULT_MODELS.claude.model, 'claude-sonnet-5');
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
      const parsed = delegateTaskSchema.parse({ prompt: 'do the thing' });
      assert.equal(parsed.sandbox, DEFAULT_SANDBOX);
      assert.equal(parsed.sandbox, 'workspace-write');
      assert.equal(parsed.task_type, 'implementation');
      assert.equal(parsed.agent, 'auto');
      assert.equal(parsed.balance_quota, true);
    });

    it('should keep parallel batches write-capable', () => {
      const parsed = delegateParallelSchema.parse({ tasks: ['a', 'b'] });
      assert.equal(parsed.sandbox, 'workspace-write');
      assert.equal(parsed.agent, 'auto');
    });

    it('should apply the configured model and effort per invoker', () => {
      const agy = invokeAgySchema.parse({ prompt: 'x' });
      assert.equal(agy.model, DEFAULT_MODELS.agy.model);
      assert.equal(agy.effort, DEFAULT_MODELS.agy.effort);
      assert.equal(agy.mode, 'accept-edits');

      const codex = invokeCodexSchema.parse({ prompt: 'x' });
      assert.equal(codex.model, DEFAULT_MODELS.codex.model);
      assert.equal(codex.effort, DEFAULT_MODELS.codex.effort);
      assert.equal(codex.sandbox, 'workspace-write');

      const claude = invokeClaudeSchema.parse({ prompt: 'x' });
      assert.equal(claude.model, DEFAULT_MODELS.claude.model);
      assert.equal(claude.effort, DEFAULT_MODELS.claude.effort);
      assert.equal(claude.mode, 'workspace-write');
    });

    it('should still honour an explicit override', () => {
      const parsed = invokeAgySchema.parse({ prompt: 'x', model: 'gemini-3.1-pro', effort: 'low' });
      assert.equal(parsed.model, 'gemini-3.1-pro');
      assert.equal(parsed.effort, 'low');
    });
  });
});
