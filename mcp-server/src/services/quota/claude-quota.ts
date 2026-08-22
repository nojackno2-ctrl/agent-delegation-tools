import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentQuotaReport, QuotaWindow } from '../../core/types.js';

export function parseClaudeUsageResponse(rawJson: string, observedAt: string): AgentQuotaReport {
  let json: any;
  try {
    json = JSON.parse(rawJson);
  } catch (err: any) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: `Failed to parse Claude usage JSON: ${err.message}`,
      windows: [],
    };
  }

  if (json.error) {
    const msg = json.error.message || JSON.stringify(json.error);
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: `Claude usage query failed: ${msg}`,
      windows: [],
    };
  }

  const windowDefs = [
    { prop: 'five_hour', name: 'Claude (5h)', duration: 300 },
    { prop: 'seven_day', name: 'Claude (7d)', duration: 10080 },
    { prop: 'seven_day_opus', name: 'Claude Opus (7d)', duration: 10080 },
    { prop: 'seven_day_sonnet', name: 'Claude Sonnet (7d)', duration: 10080 },
    { prop: 'seven_day_oauth_apps', name: 'Claude OAuth Apps (7d)', duration: 10080 },
    { prop: 'seven_day_cowork', name: 'Claude Cowork (7d)', duration: 10080 },
  ];

  const windows: QuotaWindow[] = [];
  for (const def of windowDefs) {
    const win = json[def.prop];
    if (!win || win.utilization === undefined || win.utilization === null) continue;

    const used = Math.max(0, Math.min(100, Math.round(Number(win.utilization))));
    const resetIso = win.resets_at ? String(win.resets_at) : null;
    let resetUnix: number | null = null;
    if (resetIso) {
      const parsedDate = Date.parse(resetIso);
      if (!isNaN(parsedDate)) resetUnix = Math.floor(parsedDate / 1000);
    }

    windows.push({
      name: def.name,
      usedPercent: used,
      remainingPercent: 100 - used,
      windowDurationMins: def.duration,
      resetsAt: resetIso,
      resetsAtUnix: resetUnix,
    });
  }

  if (windows.length === 0) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: 'Claude responded but returned no recognizable usage windows.',
      windows: [],
    };
  }

  return {
    agent: 'claude',
    availability: 'available',
    observedAt,
    message: 'Read from Claude OAuth usage endpoint https://api.anthropic.com/api/oauth/usage.',
    windows,
  };
}

export async function getClaudeQuota(options?: { timeoutSec?: number }): Promise<AgentQuotaReport> {
  const observedAt = new Date().toISOString();
  const timeoutSec = options?.timeoutSec || 15;

  if (process.env.FAKE_CLAUDE_STATUS_RESPONSE) {
    return parseClaudeUsageResponse(process.env.FAKE_CLAUDE_STATUS_RESPONSE, observedAt);
  }

  let credentialsPath: string | null = null;
  if (process.env.CLAUDE_CONFIG_DIR) {
    credentialsPath = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
  } else if (process.env.USERPROFILE) {
    credentialsPath = path.join(process.env.USERPROFILE, '.claude', '.credentials.json');
  }

  if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: 'Claude Code credentials not found. Run claude auth login first.',
      windows: [],
    };
  }

  let accessToken = '';
  try {
    const rawCreds = fs.readFileSync(credentialsPath, 'utf8');
    const credsJson = JSON.parse(rawCreds);
    accessToken = credsJson.claudeAiOauth?.accessToken || '';
  } catch (err: any) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: `Failed to read Claude credentials: ${err.message}`,
      windows: [],
    };
  }

  if (!accessToken) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: 'Claude Code is not logged in with an OAuth account. Run claude auth login first.',
      windows: [],
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        'User-Agent': 'agent-delegation-tools/1.0.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const bodyText = await response.text();
    if (!response.ok) {
      return {
        agent: 'claude',
        availability: 'unavailable',
        observedAt,
        message: `Claude usage query failed (HTTP ${response.status}): ${bodyText}`,
        windows: [],
      };
    }

    return parseClaudeUsageResponse(bodyText, observedAt);
  } catch (err: any) {
    return {
      agent: 'claude',
      availability: 'unavailable',
      observedAt,
      message: `Claude usage request failed: ${err.message}`,
      windows: [],
    };
  }
}
