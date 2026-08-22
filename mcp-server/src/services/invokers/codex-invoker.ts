import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveCodexExecutable } from '../../core/executables.js';
import { spawnProcess } from '../../core/process.js';
import { ensureAsciiDirectory } from '../../core/junction.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';

export interface InvokeCodexOptions {
  prompt: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string;
  effort?: string;
  workDir?: string;
  addDirs?: string[];
  outFile?: string;
  timeoutSec?: number;
  codexPath?: string;
  approveForMe?: boolean;
}

export async function invokeCodex(options: InvokeCodexOptions): Promise<ExecutionResult> {
  let executable: string;
  try {
    executable = resolveCodexExecutable(options.codexPath);
  } catch (err: any) {
    return {
      exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
      stdout: '',
      stderr: err.message,
      durationMs: 0,
    };
  }

  const sandbox = options.sandbox || 'workspace-write';
  const targetDir = options.workDir || process.cwd();

  // Resolve ASCII directory via Junction if path contains non-ASCII characters
  const dirResolution = ensureAsciiDirectory(targetDir);

  const tempOutFile =
    options.outFile ||
    path.join(os.tmpdir(), `mcp-codex-out-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.txt`);

  const args: string[] = [
    'exec',
    '--sandbox',
    sandbox,
    '--cd',
    dirResolution.effectivePath,
    '--color',
    'never',
    '--ephemeral',
  ];

  if (options.model) {
    args.push('-m', options.model);
  }

  if (options.effort) {
    args.push('-c', `model_reasoning_effort="${options.effort}"`);
  }

  if (options.addDirs) {
    for (const d of options.addDirs) {
      if (d) {
        const asciiAddDir = ensureAsciiDirectory(d);
        args.push('--add-dir', asciiAddDir.effectivePath);
      }
    }
  }

  // Pass prompt to exec
  args.push(options.prompt);

  const timeoutMs = (options.timeoutSec || 900) * 1000;

  try {
    const result = await spawnProcess({
      executable,
      args,
      cwd: dirResolution.effectivePath,
      timeoutMs,
    });

    let output = '';
    if (fs.existsSync(tempOutFile)) {
      try {
        output = fs.readFileSync(tempOutFile, 'utf8');
        if (!options.outFile) fs.unlinkSync(tempOutFile);
      } catch {
        // ignore
      }
    }

    if (!output.trim()) {
      output = result.stdout;
    }

    // Login check
    if (/login|sign in|auth required|not authenticated/i.test(result.stderr + output) && result.exitCode !== 0) {
      return {
        ...result,
        exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
        output: output.trim(),
        stderr: `Codex authentication required (Exit 78):\n${result.stderr || output}`,
      };
    }

    return {
      ...result,
      output: output.trim(),
    };
  } finally {
    dirResolution.cleanup();
  }
}
