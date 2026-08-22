import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveAgyExecutable } from '../../core/executables.js';
import { spawnProcess } from '../../core/process.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';

export interface InvokeAgyOptions {
  prompt: string;
  mode?: 'plan' | 'accept-edits' | 'read-only' | 'workspace-write';
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  workDir?: string;
  addDirs?: string[];
  outFile?: string;
  timeoutSec?: number;
  agyPath?: string;
  skipPermissions?: boolean;
}

export async function invokeAgy(options: InvokeAgyOptions): Promise<ExecutionResult> {
  let executable: string;
  try {
    executable = resolveAgyExecutable(options.agyPath);
  } catch (err: any) {
    return {
      exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
      stdout: '',
      stderr: err.message,
      durationMs: 0,
    };
  }

  const effectiveMode =
    options.mode === 'read-only' ? 'plan' : options.mode === 'workspace-write' ? 'accept-edits' : options.mode || 'plan';

  let effectiveModel = options.model || 'gemini-3.7-flash';
  let effectiveEffort = options.effort;

  // Normalize model and effort aliases
  const effortMatch = effectiveModel.match(/^gemini[ -]?3\.7[ -]?flash\s*\((high|medium|low)\)$/i);
  if (effortMatch) {
    effectiveModel = 'gemini-3.7-flash';
    if (!effectiveEffort) effectiveEffort = effortMatch[1].toLowerCase() as any;
  }

  // AGY CLI requires --effort for Flash models
  if (/gemini-3\.[0-9]-flash/i.test(effectiveModel) && !effectiveEffort) {
    effectiveEffort = 'low';
  }

  const args: string[] = [
    '-p',
    options.prompt,
    '--mode',
    effectiveMode,
    '--output-format',
    'text',
    '--print-timeout',
    '5m',
  ];

  if (effectiveModel) args.push('--model', effectiveModel);
  if (effectiveEffort) args.push('--effort', effectiveEffort);
  if (effectiveMode === 'accept-edits' || options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.addDirs) {
    for (const d of options.addDirs) {
      if (d) args.push('--add-dir', d);
    }
  }

  const timeoutMs = (options.timeoutSec || 900) * 1000;
  const result = await spawnProcess({
    executable,
    args,
    cwd: options.workDir || process.cwd(),
    timeoutMs,
  });

  const combinedOutput = result.stdout + (result.stderr ? '\n' + result.stderr : '');

  if (options.outFile) {
    try {
      fs.writeFileSync(options.outFile, combinedOutput, 'utf8');
    } catch {
      // ignore
    }
  }

  // Login failure detection
  if (/login|sign in|auth required|not authenticated/i.test(combinedOutput) && result.exitCode !== 0) {
    return {
      ...result,
      exitCode: EXIT_CODES.CONFIG_AUTH_ERROR,
      output: combinedOutput.trim(),
      stderr: `Antigravity authentication required (Exit 78):\n${combinedOutput}`,
    };
  }

  return {
    ...result,
    output: (result.stdout || combinedOutput).trim(),
  };
}
