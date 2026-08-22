import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find the repository root where delegate.ps1, status.ps1 etc. reside
export function getRepoRoot(): string {
  // If running from dist/utils/powershell.js, repo root is ../../
  const candidate1 = path.resolve(__dirname, '..', '..', '..');
  if (fs.existsSync(path.join(candidate1, 'delegate.ps1'))) {
    return candidate1;
  }
  const candidate2 = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(candidate2, 'delegate.ps1'))) {
    return candidate2;
  }
  // Fallback to process.cwd()
  return process.cwd();
}

export interface PowerShellRunOptions {
  scriptName: string;
  args?: Record<string, string | number | boolean | string[] | undefined>;
  positionalArgs?: string[];
  workDir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PowerShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runPowerShellScript(options: PowerShellRunOptions): Promise<PowerShellResult> {
  const repoRoot = getRepoRoot();
  const scriptPath = path.join(repoRoot, options.scriptName);

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`PowerShell script not found: ${scriptPath}`);
  }

  const pwshArgs: string[] = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];

  // Process positional args
  if (options.positionalArgs && options.positionalArgs.length > 0) {
    for (const arg of options.positionalArgs) {
      pwshArgs.push(arg);
    }
  }

  // Process named arguments
  if (options.args) {
    for (const [key, value] of Object.entries(options.args)) {
      if (value === undefined || value === null) {
        continue;
      }
      const paramName = key.startsWith('-') ? key : `-${key}`;
      if (typeof value === 'boolean') {
        if (value) {
          pwshArgs.push(paramName);
        }
      } else if (Array.isArray(value)) {
        if (value.length > 0) {
          pwshArgs.push(paramName);
          for (const item of value) {
            pwshArgs.push(String(item));
          }
        }
      } else {
        pwshArgs.push(paramName);
        pwshArgs.push(String(value));
      }
    }
  }

  const startTime = Date.now();

  return new Promise<PowerShellResult>((resolve, reject) => {
    // Choose powershell.exe on Windows by default, or pwsh if cross-platform
    const psExecutable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

    const child = spawn(psExecutable, pwshArgs, {
      cwd: options.workDir || repoRoot,
      env: {
        ...process.env,
        ...options.env,
        // Ensure UTF-8 console output where supported
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin to avoid stdin hangs
      windowsHide: true,
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        durationMs,
      });
    });
  });
}
