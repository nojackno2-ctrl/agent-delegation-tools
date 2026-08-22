import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearQuotaCache } from '../services/quota/quota-service.js';
import { delegateParallel } from '../services/dispatcher/parallel-service.js';
import { delegateTask } from '../services/dispatcher/delegate-service.js';
import { EXIT_CODES } from '../core/types.js';

describe('Dispatcher & Delegation Router', () => {
  beforeEach(() => {
    clearQuotaCache();
    process.env.FAKE_CLAUDE_STATUS_RESPONSE = JSON.stringify({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 20 },
    });
    process.env.FAKE_AGY_STATUS_RESPONSE = JSON.stringify({
      clientModelConfigs: [
        { label: 'Gemini 3.7 Flash', quotaInfo: { remainingFraction: 0.9 } },
      ],
    });
  });

  describe('Recursion Guard & Safety', () => {
    it('should refuse recursive delegation when AGENT_DELEGATION_DEPTH is >= 1', async () => {
      process.env.AGENT_DELEGATION_DEPTH = '1';
      try {
        const result = await delegateTask({
          prompt: 'Recursion test',
          taskType: 'analysis',
          balanceQuota: false,
        });

        assert.equal(result.exitCode, EXIT_CODES.ALL_DEPLETED);
        assert.match(result.stderr, /Refusing recursive delegation/);
      } finally {
        delete process.env.AGENT_DELEGATION_DEPTH;
      }
    });
  });

  describe('Parallel Worker Pool with Recursion Safety', () => {
    it('should maintain task index mapping even when underlying tasks are guarded', async () => {
      process.env.AGENT_DELEGATION_DEPTH = '1';
      try {
        const tasks = ['TASK_A', 'TASK_B', 'TASK_C', 'TASK_D'];
        const results = await delegateParallel({
          tasks,
          maxConcurrency: 2,
        });

        assert.equal(results.length, 4);
        assert.equal(results[0].index, 0);
        assert.equal(results[0].prompt, 'TASK_A');
        assert.equal(results[1].index, 1);
        assert.equal(results[1].prompt, 'TASK_B');
        assert.equal(results[2].index, 2);
        assert.equal(results[2].prompt, 'TASK_C');
        assert.equal(results[3].index, 3);
        assert.equal(results[3].prompt, 'TASK_D');
      } finally {
        delete process.env.AGENT_DELEGATION_DEPTH;
      }
    });
  });
});
