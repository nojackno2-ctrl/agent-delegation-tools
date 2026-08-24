import { AgentName, AgentQuotaReport } from '../../core/types.js';
import { getCodexQuota } from './codex-quota.js';
import { getClaudeQuota } from './claude-quota.js';
import { getAgyQuota } from './agy-quota.js';

export interface ProviderHealth {
  agent: AgentName;
  available: boolean;
  minRemainingPercent: number;
  report: AgentQuotaReport;
}

interface QuotaCacheEntry {
  report: AgentQuotaReport;
  timestamp: number;
}

const quotaCache = new Map<AgentName, QuotaCacheEntry>();
const DEFAULT_QUOTA_CACHE_TTL_MS = 10_000; // 10 seconds

export function clearQuotaCache(): void {
  quotaCache.clear();
}

export function markProviderDepleted(agent: AgentName): void {
  const existing = quotaCache.get(agent);
  if (existing) {
    existing.report.availability = 'depleted';
    if (existing.report.windows) {
      for (const w of existing.report.windows) {
        w.remainingPercent = 0;
        w.usedPercent = 100;
      }
    }
  } else {
    quotaCache.set(agent, {
      report: {
        agent,
        availability: 'depleted',
        observedAt: new Date().toISOString(),
        message: 'Provider quota limit reached during execution.',
        windows: [{ name: agent, remainingPercent: 0, usedPercent: 100 }],
      },
      timestamp: Date.now(),
    });
  }
}


export interface QuotaQueryOptions {
  timeoutSec?: number;
  codexPath?: string;
  workDir?: string;
  bypassCache?: boolean;
  ttlMs?: number;
}

export async function getAgentQuota(
  agent: AgentName,
  options?: QuotaQueryOptions
): Promise<AgentQuotaReport> {
  const ttl = options?.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS;
  const bypass = options?.bypassCache === true;

  if (!bypass) {
    const cached = quotaCache.get(agent);
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.report;
    }
  }

  let report: AgentQuotaReport;
  switch (agent) {
    case 'codex':
      report = await getCodexQuota({
        codexPath: options?.codexPath,
        timeoutSec: options?.timeoutSec,
        workDir: options?.workDir,
      });
      break;
    case 'claude':
      report = await getClaudeQuota({ timeoutSec: options?.timeoutSec });
      break;
    case 'agy':
      report = await getAgyQuota({ timeoutSec: options?.timeoutSec });
      break;
    default:
      throw new Error(`Unsupported agent: ${agent}`);
  }

  quotaCache.set(agent, { report, timestamp: Date.now() });
  return report;
}

export async function getAllQuotas(options?: QuotaQueryOptions): Promise<AgentQuotaReport[]> {
  return await Promise.all([
    getAgentQuota('codex', options),
    getAgentQuota('agy', options),
    getAgentQuota('claude', options),
  ]);
}

export function evaluateProviderHealth(report: AgentQuotaReport): ProviderHealth {
  if (report.availability !== 'available' || !report.windows || report.windows.length === 0) {
    return {
      agent: report.agent,
      available: false,
      minRemainingPercent: 0,
      report,
    };
  }

  let minRemaining = 100;
  for (const win of report.windows) {
    if (win.remainingPercent < minRemaining) {
      minRemaining = win.remainingPercent;
    }
  }

  return {
    agent: report.agent,
    available: minRemaining > 10,
    minRemainingPercent: minRemaining,
    report,
  };
}

export async function getDynamicQuotaHealth(
  options?: QuotaQueryOptions
): Promise<Record<AgentName, ProviderHealth>> {
  const reports = await getAllQuotas(options);
  const result: Partial<Record<AgentName, ProviderHealth>> = {};

  for (const report of reports) {
    result[report.agent] = evaluateProviderHealth(report);
  }

  return result as Record<AgentName, ProviderHealth>;
}

