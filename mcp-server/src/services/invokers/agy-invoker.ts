import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveAgyExecutable } from '../../core/executables.js';
import { spawnProcess } from '../../core/process.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';
import { DEFAULT_MODELS } from '../../core/defaults.js';

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
    options.mode === 'read-only'
      ? 'plan'
      : options.mode === 'workspace-write'
        ? 'accept-edits'
        : options.mode || 'accept-edits';

  let effectiveModel = options.model || DEFAULT_MODELS.agy.model;
  let effectiveEffort = options.effort;

  // Normalize model and effort aliases
  const effortParenMatch = effectiveModel.match(/^gemini[ -]?(3\.[5678])[ -]?flash\s*\((high|medium|low)\)$/i);
  if (effortParenMatch) {
    effectiveModel = `gemini-${effortParenMatch[1]}-flash`;
    if (!effectiveEffort) effectiveEffort = effortParenMatch[2].toLowerCase() as any;
  } else {
    const effortHyphenMatch = effectiveModel.match(/^gemini[ -]?(3\.[5678])[ -]?flash-(high|medium|low)$/i);
    if (effortHyphenMatch) {
      effectiveModel = `gemini-${effortHyphenMatch[1]}-flash`;
      if (!effectiveEffort) effectiveEffort = effortHyphenMatch[2].toLowerCase() as any;
    } else {
      const thinkingMatch = effectiveModel.match(/^gemini[ -]?(3\.[5678])[ -]?flash-thinking$/i);
      if (thinkingMatch) {
        effectiveModel = `gemini-${thinkingMatch[1]}-flash`;
        if (!effectiveEffort) effectiveEffort = 'high';
      } else {
        const plainFlashMatch = effectiveModel.match(/^(?:gemini[ -]?)?(3\.[5678])[ -]?flash$/i);
        if (plainFlashMatch) {
          effectiveModel = `gemini-${plainFlashMatch[1]}-flash`;
        }
      }
    }
  }

  // AGY CLI rejects Flash models without --effort, so always carry one.
  if (!effectiveEffort) {
    effectiveEffort = DEFAULT_MODELS.agy.effort;
  }

  const timeoutSec = options.timeoutSec || 900;
  const workDir = path.resolve(options.workDir || process.cwd());

  const args: string[] = [
    '-p',
    options.prompt,
    '--mode',
    effectiveMode,
    '--output-format',
    'text',
    // AGY's own print wait defaults to 5m and silently truncates the turn, so it
    // must follow the caller's timeout rather than a fixed value.
    '--print-timeout',
    `${timeoutSec}s`,
  ];

  if (effectiveModel) args.push('--model', effectiveModel);
  if (effectiveEffort) args.push('--effort', effectiveEffort);
  // A headless child has no terminal to answer a permission prompt on, so a
  // prompt is a hang, not a safety net. Work stays bounded by workDir/addDirs.
  if (options.skipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  // AGY does not treat its cwd as a workspace: without --add-dir it runs with
  // "No active workspace", cannot resolve relative paths, and wanders the drives.
  const workspaceDirs = [workDir, ...(options.addDirs || []).filter(Boolean).map((d) => path.resolve(d))];
  for (const d of new Set(workspaceDirs)) {
    args.push('--add-dir', d);
  }

  // Give AGY's own print timeout a head start so its output is flushed before we kill it.
  const timeoutMs = (timeoutSec + 30) * 1000;
  const result = await spawnProcess({
    executable,
    args,
    cwd: workDir,
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
