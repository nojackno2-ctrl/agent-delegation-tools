import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsageResponse } from '../services/quota/claude-quota.js';
import { parseAgyUsageResponse } from '../services/quota/agy-quota.js';
import { evaluateProviderHealth } from '../services/quota/quota-service.js';
import { AgentQuotaReport } from '../core/types.js';

describe('Quota Response Parsers', () => {
  describe('parseClaudeUsageResponse', () => {
    it('should parse valid 5-hour and 7-day usage windows', () => {
      const payload = JSON.stringify({
        five_hour: { utilization: 25, resets_at: '2026-08-22T10:00:00Z' },
        seven_day: { utilization: 60, resets_at: '2026-08-25T10:00:00Z' },
      });
      const res = parseClaudeUsageResponse(payload, new Date().toISOString());

      assert.equal(res.agent, 'claude');
      assert.equal(res.availability, 'available');
      assert.equal(res.windows?.length, 2);

      const win5h = res.windows?.find((w) => w.name === 'Claude (5h)');
      assert.ok(win5h);
      assert.equal(win5h?.usedPercent, 25);
      assert.equal(win5h?.remainingPercent, 75);
      assert.equal(win5h?.windowDurationMins, 300);

      const win7d = res.windows?.find((w) => w.name === 'Claude (7d)');
      assert.ok(win7d);
      assert.equal(win7d?.usedPercent, 60);
      assert.equal(win7d?.remainingPercent, 40);
      assert.equal(win7d?.windowDurationMins, 10080);
    });

    it('should handle API error payload', () => {
      const payload = JSON.stringify({
        error: { message: 'Authentication required' },
      });
      const res = parseClaudeUsageResponse(payload, new Date().toISOString());
      assert.equal(res.agent, 'claude');
      assert.equal(res.availability, 'unavailable');
      assert.match(res.message, /Authentication required/);
    });

    it('should handle invalid JSON payload', () => {
      const res = parseClaudeUsageResponse('Not a JSON', new Date().toISOString());
      assert.equal(res.agent, 'claude');
      assert.equal(res.availability, 'unavailable');
      assert.match(res.message, /Failed to parse/);
    });
  });

  describe('parseAgyUsageResponse', () => {
    it('should parse Gemini and Claude / GPT model configurations', () => {
      const payload = JSON.stringify({
        clientModelConfigs: [
          {
            label: 'Gemini 3.7 Flash',
            quotaInfo: {
              remainingFraction: 0.85,
              resetTime: '2026-08-22T12:00:00Z',
            },
          },
          {
            label: 'Claude 3.5 Sonnet',
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: '2026-08-22T14:00:00Z',
            },
          },
        ],
      });
      const res = parseAgyUsageResponse(payload, new Date().toISOString());

      assert.equal(res.agent, 'agy');
      assert.equal(res.availability, 'available');
      assert.equal(res.windows?.length, 2);

      const geminiWin = res.windows?.find((w) => w.name === 'agy (Gemini)');
      assert.ok(geminiWin);
      assert.equal(geminiWin?.remainingPercent, 85);
      assert.equal(geminiWin?.usedPercent, 15);

      const claudeWin = res.windows?.find((w) => w.name === 'agy (Claude / GPT)');
      assert.ok(claudeWin);
      assert.equal(claudeWin?.remainingPercent, 50);
      assert.equal(claudeWin?.usedPercent, 50);
    });

    it('should handle empty or missing clientModelConfigs', () => {
      const payload = JSON.stringify({ clientModelConfigs: [] });
      const res = parseAgyUsageResponse(payload, new Date().toISOString());
      assert.equal(res.agent, 'agy');
      assert.equal(res.availability, 'unavailable');
    });
  });

  describe('evaluateProviderHealth', () => {
    it('should mark provider as available when remaining > 10%', () => {
      const report: AgentQuotaReport = {
        agent: 'codex',
        availability: 'available',
        message: 'OK',
        windows: [{ name: 'codex', remainingPercent: 40, usedPercent: 60 }],
      };
      const health = evaluateProviderHealth(report);
      assert.equal(health.available, true);
      assert.equal(health.minRemainingPercent, 40);
    });

    it('should mark provider as unavailable/depleted when remaining <= 10%', () => {
      const report: AgentQuotaReport = {
        agent: 'codex',
        availability: 'available',
        message: 'Near limit',
        windows: [{ name: 'codex', remainingPercent: 5, usedPercent: 95 }],
      };
      const health = evaluateProviderHealth(report);
      assert.equal(health.available, false);
      assert.equal(health.minRemainingPercent, 5);
    });

    it('should mark provider as unavailable when report availability is not available', () => {
      const report: AgentQuotaReport = {
        agent: 'claude',
        availability: 'unavailable',
        message: 'Auth error',
        windows: [],
      };
      const health = evaluateProviderHealth(report);
      assert.equal(health.available, false);
      assert.equal(health.minRemainingPercent, 0);
    });
  });
});
