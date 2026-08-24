import { spawn, ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { resolveCodexExecutable } from '../../core/executables.js';
import { killProcessTree } from '../../core/process.js';
import { AgentQuotaReport, QuotaWindow } from '../../core/types.js';

export async function getCodexQuota(options: {
  codexPath?: string;
  timeoutSec?: number;
  workDir?: string;
}): Promise<AgentQuotaReport> {
  const observedAt = new Date().toISOString();
  const timeoutSec = options.timeoutSec || 15;

  let executable: string;
  try {
    executable = resolveCodexExecutable(options.codexPath);
  } catch (err: any) {
    return {
      agent: 'codex',
      availability: 'unavailable',
      observedAt,
      message: err.message || 'Codex executable not found.',
      windows: [],
    };
  }

  return new Promise<AgentQuotaReport>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
        cwd: options.workDir || process.cwd(),
        env: {
          ...process.env,
          PYTHONUTF8: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: any) {
      resolve({
        agent: 'codex',
        availability: 'unavailable',
        observedAt,
        message: `Failed to spawn Codex app-server: ${err.message}`,
        windows: [],
      });
      return;
    }

    let isResolved = false;
    const cleanup = () => {
      if (!isResolved) {
        isResolved = true;
        if (child.pid) killProcessTree(child.pid);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        agent: 'codex',
        availability: 'unavailable',
        observedAt,
        message: `Timed out waiting for Codex app-server response after ${timeoutSec}s.`,
        windows: [],
      });
    }, timeoutSec * 1000);

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 0) {
          // Initialize response
          if (msg.error) {
            clearTimeout(timer);
            cleanup();
            resolve({
              agent: 'codex',
              availability: 'unavailable',
              observedAt,
              message: `Codex app-server initialize failed: ${msg.error.message || JSON.stringify(msg.error)}`,
              windows: [],
            });
            return;
          }
          // Send initialized and read rate limits
          child.stdin?.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin?.write(JSON.stringify({ method: 'account/rateLimits/read', id: 1 }) + '\n');
        } else if (msg.id === 1) {
          clearTimeout(timer);
          cleanup();

          if (msg.error) {
            resolve({
              agent: 'codex',
              availability: 'unavailable',
              observedAt,
              message: `Codex usage query failed: ${msg.error.message || JSON.stringify(msg.error)}`,
              windows: [],
            });
            return;
          }

          const buckets = msg.result?.rateLimitsByLimitId || (msg.result?.rateLimits ? { codex: msg.result.rateLimits } : {});
          const windows: QuotaWindow[] = [];

          for (const [key, rawBucket] of Object.entries<any>(buckets)) {
            const bucketName = rawBucket.limitName || rawBucket.limitId || key;
            for (const windowName of ['primary', 'secondary']) {
              const win = rawBucket[windowName];
              if (!win || win.usedPercent === undefined || win.usedPercent === null) continue;

              const used = Math.max(0, Math.min(100, Math.round(Number(win.usedPercent))));
              const resetUnix = win.resetsAt ? Number(win.resetsAt) : null;
              const resetIso = resetUnix ? new Date(resetUnix * 1000).toISOString() : null;

              windows.push({
                name: windowName === 'primary' ? bucketName : `${bucketName} secondary`,
                usedPercent: used,
                remainingPercent: 100 - used,
                windowDurationMins: win.windowDurationMins ? Number(win.windowDurationMins) : null,
                resetsAt: resetIso,
                resetsAtUnix: resetUnix,
              });
            }
          }

          if (windows.length === 0) {
            resolve({
              agent: 'codex',
              availability: 'unavailable',
              observedAt,
              message: 'Codex returned no recognizable rate-limit windows.',
              windows: [],
            });
            return;
          }

          resolve({
            agent: 'codex',
            availability: 'available',
            observedAt,
            message: 'Read from Codex app-server account/rateLimits/read without starting a model turn.',
            windows,
          });
        }
      } catch {
        // ignore non-json or partial lines
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        agent: 'codex',
        availability: 'unavailable',
        observedAt,
        message: `Codex process error: ${err.message}`,
        windows: [],
      });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (!isResolved) {
        isResolved = true;
        resolve({
          agent: 'codex',
          availability: 'unavailable',
          observedAt,
          message: 'Codex app-server closed before sending rateLimits response.',
          windows: [],
        });
      }
    });

    // Start initialization handshake
    child.stdin?.write(
      JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'agent_delegation_tools',
            title: 'Agent Delegation Tools',
            version: '1.0.0',
          },
        },
      }) + '\n'
    );
  });
}
