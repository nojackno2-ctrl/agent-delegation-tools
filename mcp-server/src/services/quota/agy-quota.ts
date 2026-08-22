import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { execSync } from 'node:child_process';
import { AgentQuotaReport, QuotaWindow } from '../../core/types.js';

export function parseAgyUsageResponse(rawJson: string, observedAt: string): AgentQuotaReport {
  let json: any;
  try {
    json = JSON.parse(rawJson);
  } catch (err: any) {
    return {
      agent: 'agy',
      availability: 'unavailable',
      observedAt,
      message: `Failed to parse Antigravity usage JSON: ${err.message}`,
      windows: [],
    };
  }

  if (json.error) {
    const msg = json.error.message || JSON.stringify(json.error);
    return {
      agent: 'agy',
      availability: 'unavailable',
      observedAt,
      message: `Antigravity usage query failed: ${msg}`,
      windows: [],
    };
  }

  const configs = json.clientModelConfigs;
  if (!configs || !Array.isArray(configs) || configs.length === 0) {
    return {
      agent: 'agy',
      availability: 'unavailable',
      observedAt,
      message: 'Antigravity returned no clientModelConfigs.',
      windows: [],
    };
  }

  const windows: QuotaWindow[] = [];
  const seenPools = new Set<string>();

  for (const config of configs) {
    if (!config.quotaInfo) continue;
    const label = String(config.label || '');

    let poolName = `agy (${label})`;
    if (/gemini/i.test(label)) {
      poolName = 'agy (Gemini)';
    } else if (/(claude|gpt)/i.test(label)) {
      poolName = 'agy (Claude / GPT)';
    }

    if (seenPools.has(poolName)) continue;
    seenPools.add(poolName);

    let remFraction = 1.0;
    if (config.quotaInfo.remainingFraction !== undefined && config.quotaInfo.remainingFraction !== null) {
      remFraction = Math.max(0.0, Math.min(1.0, Number(config.quotaInfo.remainingFraction)));
    }
    const remainingPercent = Math.round(remFraction * 100);
    const usedPercent = 100 - remainingPercent;

    const resetIso = config.quotaInfo.resetTime ? String(config.quotaInfo.resetTime) : null;
    let resetUnix: number | null = null;
    if (resetIso) {
      const parsedDate = Date.parse(resetIso);
      if (!isNaN(parsedDate)) resetUnix = Math.floor(parsedDate / 1000);
    }

    windows.push({
      name: poolName,
      usedPercent,
      remainingPercent,
      windowDurationMins: null,
      resetsAt: resetIso,
      resetsAtUnix: resetUnix,
    });
  }

  if (windows.length === 0) {
    return {
      agent: 'agy',
      availability: 'unavailable',
      observedAt,
      message: 'Antigravity responded but returned no quotaInfo in clientModelConfigs.',
      windows: [],
    };
  }

  return {
    agent: 'agy',
    availability: 'available',
    observedAt,
    message: 'Read from Antigravity LanguageServerService GetCascadeModelConfigData RPC.',
    windows,
  };
}

interface CachedAgyConnection {
  csrfToken: string;
  port: number;
  lastVerified: number;
}

let activeAgyConnection: CachedAgyConnection | null = null;

export function clearAgyConnectionCache(): void {
  activeAgyConnection = null;
}

function findLanguageServerDetails(): { csrfToken?: string; ports: number[] } {
  let csrfToken: string | undefined;
  const candidatePorts: number[] = [];

  // 1. Fast Path: Scan log files first (pure Node.js fs read in <1ms without launching PowerShell)
  const candidateLogs: string[] = [];
  if (process.env.APPDATA) {
    candidateLogs.push(
      path.join(process.env.APPDATA, 'Antigravity', 'logs', 'language_server.log'),
      path.join(process.env.APPDATA, 'Antigravity IDE', 'logs', 'language_server.log')
    );
  }
  if (process.env.USERPROFILE) {
    candidateLogs.push(
      path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'logs', 'language_server.log')
    );
  }

  for (const logPath of candidateLogs) {
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n').slice(-300);
        for (const line of lines) {
          const mPort = line.match(/listening on \w+ port at (\d+) for HTTPS/i);
          if (mPort) {
            const p = parseInt(mPort[1], 10);
            if (!candidatePorts.includes(p)) candidatePorts.push(p);
          }
          if (!csrfToken) {
            const mCsrf = line.match(/--csrf_token[=\s]+([^\s]+)/);
            if (mCsrf) csrfToken = mCsrf[1];
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. Slow Fallback: If CSRF token or ports not found in logs, query running process via PowerShell CIM
  if ((!csrfToken || candidatePorts.length === 0) && process.platform === 'win32') {
    try {
      const script = `
        $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' }
        foreach ($p in $procs) {
          if ($p.CommandLine -match '--csrf_token\\s+([^\\s]+)') {
            $t = $Matches[1]
            $conns = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue
            $ports = ($conns | Select-Object -ExpandProperty LocalPort) -join ','
            [pscustomobject]@{ token = $t; ports = $ports } | ConvertTo-Json -Compress
            break
          }
        }
      `;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const output = execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (output.startsWith('{')) {
        const parsed = JSON.parse(output);
        if (parsed.token && !csrfToken) csrfToken = parsed.token;
        if (parsed.ports) {
          for (const p of String(parsed.ports).split(',')) {
            const num = parseInt(p.trim(), 10);
            if (!isNaN(num) && num > 0 && !candidatePorts.includes(num)) candidatePorts.push(num);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    csrfToken,
    ports: candidatePorts,
  };
}

async function tryPostRpc(port: number, csrfToken: string, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const postData = JSON.stringify({});
    const reqOptions: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(postData),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => {
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

export async function getAgyQuota(options?: { timeoutSec?: number }): Promise<AgentQuotaReport> {
  const observedAt = new Date().toISOString();
  const timeoutSec = options?.timeoutSec || 15;

  if (process.env.FAKE_AGY_STATUS_RESPONSE) {
    return parseAgyUsageResponse(process.env.FAKE_AGY_STATUS_RESPONSE, observedAt);
  }

  // 1. Try cached active connection if available (<2ms response)
  if (activeAgyConnection) {
    const fastData = await tryPostRpc(activeAgyConnection.port, activeAgyConnection.csrfToken, 1500);
    if (fastData) {
      activeAgyConnection.lastVerified = Date.now();
      return parseAgyUsageResponse(fastData, observedAt);
    }
    // Cached connection failed; reset and proceed to discovery
    activeAgyConnection = null;
  }

  const details = findLanguageServerDetails();
  if (!details.csrfToken || details.ports.length === 0) {
    return {
      agent: 'agy',
      availability: 'unavailable',
      observedAt,
      message: 'Antigravity language_server is not active or listening port/CSRF token could not be detected.',
      windows: [],
    };
  }

  const callTimeoutMs = Math.min(timeoutSec * 1000, 5000);
  for (const port of details.ports) {
    const rawData = await tryPostRpc(port, details.csrfToken, callTimeoutMs);
    if (rawData) {
      // Cache this working connection
      activeAgyConnection = {
        port,
        csrfToken: details.csrfToken,
        lastVerified: Date.now(),
      };
      return parseAgyUsageResponse(rawData, observedAt);
    }
  }

  return {
    agent: 'agy',
    availability: 'unavailable',
    observedAt,
    message: 'Failed to connect to Antigravity Language Server RPC endpoint across detected ports.',
    windows: [],
  };
}
