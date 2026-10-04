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
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
  agyPath?: string;
  skipPermissions?: boolean;
}

export async function invokeAgy(options: InvokeAgyOptions): Promise<ExecutionResult> {
  if (options.signal?.aborted) return { exitCode: EXIT_CODES.CANCELLED, stdout: '', stderr: 'Invocation cancelled.', durationMs: 0, cancelled: true };
  options.onProgress?.('agy');
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
  const flashMatch = effectiveModel.match(/^gemini[ -]?(3\.[5-8])[ -]?flash\s*\((high|medium|low)\)$/i);
  if (flashMatch) {
    effectiveModel = `gemini-${flashMatch[1]}-flash`;
    if (!effectiveEffort) effectiveEffort = flashMatch[2].toLowerCase() as any;
  }
  const flashDashMatch = effectiveModel.match(/^gemini[ -]?(3\.[5-8])[ -]?flash-(high|medium|low)$/i);
  if (flashDashMatch) {
    effectiveModel = `gemini-${flashDashMatch[1]}-flash`;
    if (!effectiveEffort) effectiveEffort = flashDashMatch[2].toLowerCase() as any;
  }
  const proMatch = effectiveModel.match(/^gemini[ -]?(3\.1)[ -]?pro\s*\((high|low)\)$/i);
  if (proMatch) {
    effectiveModel = 'gemini-3.1-pro';
    if (!effectiveEffort) effectiveEffort = proMatch[2].toLowerCase() as any;
  }
  const claudeMatch = effectiveModel.match(/^claude[ -]?(opus|sonnet)[ -]?(?:5\.5|5-5)\s*\((high|medium|low)\)$/i);
  if (claudeMatch) {
    effectiveModel = `claude-${claudeMatch[1].toLowerCase()}-5-5`;
    if (!effectiveEffort) effectiveEffort = claudeMatch[2].toLowerCase() as any;
  }
  const claudeDashMatch = effectiveModel.match(/^claude[ -]?(opus|sonnet)[ -]?(?:5\.5|5-5)-(high|medium|low)$/i);
  if (claudeDashMatch) {
    effectiveModel = `claude-${claudeDashMatch[1].toLowerCase()}-5-5`;
    if (!effectiveEffort) effectiveEffort = claudeDashMatch[2].toLowerCase() as any;
  }
  const gptOssMatch = effectiveModel.match(/^gpt[ -]?oss[ -]?120b(?:\s*\(medium\)|-medium)?$/i);
  if (gptOssMatch) {
    effectiveModel = 'gpt-oss-120b-medium';
  }

  // AGY CLI rejects Flash models without --effort, so always carry one.
  if (!effectiveEffort) {
    effectiveEffort = DEFAULT_MODELS.agy.effort;
  }

  const args: string[] = [
    '-p',
    options.prompt,
    '--mode',
    effectiveMode,
    '--output-format',
    'text',
    '--print-timeout',
    options.timeoutSec ? `${options.timeoutSec}s` : '0',
  ];

  if (effectiveModel) args.push('--model', effectiveModel);
  if (effectiveEffort) args.push('--effort', effectiveEffort);
  // A headless child has no terminal to answer a permission prompt on, so a
  // prompt is a hang, not a safety net. Work stays bounded by workDir/addDirs.
  if (options.skipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.addDirs) {
    for (const d of options.addDirs) {
      if (d) args.push('--add-dir', d);
    }
  }

  // 0/undefined = no limit: long-running subagents are left to finish.
  const timeoutMs = (options.timeoutSec ?? 0) * 1000;
  const result = await spawnProcess({
    executable,
    args,
    cwd: options.workDir || process.cwd(),
    timeoutMs,
    signal: options.signal,
    onStdout: () => options.onProgress?.('agy'),
    onStderr: () => options.onProgress?.('agy'),
  });

  const combinedOutput = result.stdout + (result.stderr ? '\n' + result.stderr : '');

  if (options.outFile) {
    try {
      fs.writeFileSync(options.outFile, combinedOutput, 'utf8');
    } catch {
      // ignore
    }
  }

  if (result.cancelled || result.timedOut) return { ...result, output: combinedOutput.trim() };

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
