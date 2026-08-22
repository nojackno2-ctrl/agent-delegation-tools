import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { ExecutionResult, EXIT_CODES } from './types.js';

export function formatWindowsArgument(val: string): string {
  if (val === '') return '""';
  if (!/[\s"]/.test(val)) return val;
  const escaped = val.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

export function killProcessTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

export interface SpawnProcessOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinString?: string;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export async function spawnProcess(options: SpawnProcessOptions): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Recursion guard
  const depth = parseInt(process.env.AGENT_DELEGATION_DEPTH || '0', 10);
  if (depth >= 1) {
    return {
      exitCode: EXIT_CODES.ALL_DEPLETED,
      stdout: '',
      stderr: `Refusing recursive delegation: AGENT_DELEGATION_DEPTH=${depth}.`,
      durationMs: 0,
    };
  }

  const isCmdOrBat = /\.(cmd|bat)$/i.test(options.executable);
  let launchExecutable = options.executable;
  let launchArgs = options.args;

  if (isCmdOrBat && process.platform === 'win32') {
    const comSpec = process.env.ComSpec || 'cmd.exe';
    launchExecutable = comSpec;
    const innerArgs = [options.executable, ...options.args].map(formatWindowsArgument).join(' ');
    launchArgs = ['/d', '/s', '/c', `"${innerArgs}"`];
  }

  return new Promise<ExecutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launchExecutable, launchArgs, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          ...options.env,
          AGENT_DELEGATION_DEPTH: String(depth + 1),
          PYTHONUTF8: '1',
        },
        stdio: [options.stdinString !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: any) {
      resolve({
        exitCode: EXIT_CODES.GENERIC_FAILURE,
        stdout: '',
        stderr: `Failed to spawn process: ${err?.message || String(err)}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let timedOut = false;

    let timeoutTimer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          killProcessTree(child.pid);
        }
      }, options.timeoutMs);
    }

    if (child.stdin && options.stdinString !== undefined) {
      child.stdin.write(options.stdinString, 'utf8');
      child.stdin.end();
    }

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      if (options.onStdout) options.onStdout(chunk.toString('utf8'));
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      if (options.onStderr) options.onStderr(chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: EXIT_CODES.GENERIC_FAILURE,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `Child process error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
        durationMs,
      });
    });

    child.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        resolve({
          exitCode: EXIT_CODES.TIMEOUT,
          stdout,
          stderr: `Process timed out after ${options.timeoutMs}ms.\n${stderr}`,
          durationMs,
          timedOut: true,
        });
      } else {
        resolve({
          exitCode: code ?? EXIT_CODES.SUCCESS,
          stdout,
          stderr,
          durationMs,
        });
      }
    });
  });
}
