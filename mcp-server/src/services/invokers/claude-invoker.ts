import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveClaudeExecutable } from '../../core/executables.js';
import { spawnProcess } from '../../core/process.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';

export interface InvokeClaudeOptions {
  prompt: string;
  mode?: 'plan' | 'accept-edits' | 'read-only' | 'workspace-write' | 'danger-full-access' | string;
  context?: 'isolated' | 'project';
  model?: string;
  effort?: string;
  sessionId?: string;
  resume?: boolean;
  workDir?: string;
  addDirs?: string[];
  outFile?: string;
  timeoutSec?: number;
  claudePath?: string;
}

export async function invokeClaude(options: InvokeClaudeOptions): Promise<ExecutionResult> {
  let executable: string;
  try {
    executable = resolveClaudeExecutable(options.claudePath);
  } catch (err: any) {
    return {
      exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
      stdout: '',
      stderr: err.message,
      durationMs: 0,
    };
  }

  let permissionMode = options.mode || 'plan';
  if (permissionMode === 'read-only') permissionMode = 'plan';
  if (permissionMode === 'workspace-write') permissionMode = 'acceptEdits';
  if (permissionMode === 'danger-full-access') permissionMode = 'bypassPermissions';

  const isIsolated = options.context !== 'project';

  const args: string[] = ['-p'];
  args.push('--permission-mode', permissionMode);
  args.push('--output-format', 'json');

  if (isIsolated) {
    args.push('--safe-mode');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.sessionId) {
    if (options.resume) {
      args.push('--resume', options.sessionId);
    } else {
      args.push('--session-id', options.sessionId);
    }
  }

  if (options.addDirs) {
    for (const d of options.addDirs) {
      if (d) args.push('--add-dir', d);
    }
  }

  const timeoutMs = (options.timeoutSec || 900) * 1000;

  // Pass prompt through stdin to avoid command line limits and character encoding bugs
  const result = await spawnProcess({
    executable,
    args,
    cwd: options.workDir || process.cwd(),
    stdinString: options.prompt,
    timeoutMs,
  });

  let outputText = result.stdout;
  try {
    const json = JSON.parse(result.stdout.trim());
    if (json.result) {
      outputText = typeof json.result === 'string' ? json.result : JSON.stringify(json.result, null, 2);
    } else if (json.message) {
      outputText = json.message;
    }
  } catch {
    // raw stdout
  }

  if (options.outFile) {
    try {
      fs.writeFileSync(options.outFile, outputText, 'utf8');
    } catch {
      // ignore
    }
  }

  // Quota and auth check
  if (/usage limit reached|rate limit|exhausted|too many requests/i.test(result.stderr + result.stdout)) {
    return {
      ...result,
      exitCode: EXIT_CODES.QUOTA_EXCEEDED,
      output: outputText.trim(),
      stderr: `Claude usage limit reached (Exit 10):\n${result.stderr || outputText}`,
    };
  }

  if (/login|sign in|auth required|not authenticated/i.test(result.stderr + result.stdout)) {
    return {
      ...result,
      exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
      output: outputText.trim(),
      stderr: `Claude authentication required (Exit 78):\n${result.stderr || outputText}`,
    };
  }

  return {
    ...result,
    output: outputText.trim(),
  };
}
