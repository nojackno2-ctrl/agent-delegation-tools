import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentQuota,
  clearQuotaCache,
  markProviderDepleted,
  evaluateProviderHealth,
} from '../services/quota/quota-service.js';

describe('Quota Cache & TTL Memoization', () => {
  beforeEach(() => {
    clearQuotaCache();
    delete process.env.FAKE_CLAUDE_STATUS_RESPONSE;
    delete process.env.FAKE_AGY_STATUS_RESPONSE;
  });

  it('should cache quota report within TTL window and serve cached report', async () => {
    process.env.FAKE_CLAUDE_STATUS_RESPONSE = JSON.stringify({
      five_hour: { utilization: 20, resets_at: '2026-08-22T10:00:00Z' },
    });

    const report1 = await getAgentQuota('claude');
    assert.equal(report1.windows?.[0].usedPercent, 20);

    // Change fake response
    process.env.FAKE_CLAUDE_STATUS_RESPONSE = JSON.stringify({
      five_hour: { utilization: 90, resets_at: '2026-08-22T10:00:00Z' },
    });

    // Second call within TTL should return cached report (20% used, not 90%)
    const report2 = await getAgentQuota('claude');
    assert.equal(report2.windows?.[0].usedPercent, 20);

    // Call with bypassCache should fetch new report (90% used)
    const report3 = await getAgentQuota('claude', { bypassCache: true });
    assert.equal(report3.windows?.[0].usedPercent, 90);
  });

  it('should immediately update status when markProviderDepleted is called', async () => {
    process.env.FAKE_AGY_STATUS_RESPONSE = JSON.stringify({
      clientModelConfigs: [
        {
          label: 'Gemini 3.7 Flash',
          quotaInfo: { remainingFraction: 0.9, resetTime: '2026-08-22T12:00:00Z' },
        },
      ],
    });

    const initial = await getAgentQuota('agy');
    assert.equal(initial.availability, 'available');
    assert.equal(initial.windows?.[0].remainingPercent, 90);

    // Mark depleted
    markProviderDepleted('agy');

    const updated = await getAgentQuota('agy');
    assert.equal(updated.availability, 'depleted');
    assert.equal(updated.windows?.[0].remainingPercent, 0);

    const health = evaluateProviderHealth(updated);
    assert.equal(health.available, false);
  });

  it('should clear all cache entries when clearQuotaCache is invoked', async () => {
    process.env.FAKE_CLAUDE_STATUS_RESPONSE = JSON.stringify({
      five_hour: { utilization: 15 },
    });

    await getAgentQuota('claude');

    process.env.FAKE_CLAUDE_STATUS_RESPONSE = JSON.stringify({
      five_hour: { utilization: 75 },
    });

    clearQuotaCache();

    const fresh = await getAgentQuota('claude');
    assert.equal(fresh.windows?.[0].usedPercent, 75);
  });
});
