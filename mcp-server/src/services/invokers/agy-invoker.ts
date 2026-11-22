import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAgyExecutable } from '../../core/executables.js';
import { runAcpPrompt } from '../../core/acp-client.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';
import { isQuotaExhausted } from '../../core/quota-signals.js';
import { DEFAULT_MODELS } from '../../core/defaults.js';

export interface InvokeAgyOptions {
  prompt: string;
  mode?: 'plan' | 'accept-edits' | 'read-only' | 'workspace-write';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  workDir?: string;
  addDirs?: string[];
  outFile?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
  agyPath?: string;
  skipPermissions?: boolean;
}

const NO_EFFORT_MODELS = new Set([
  'gpt-oss-120b-medium',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-pro-orchestrator-neon',
]);

export function normalizeAgyModelAndEffort(
  model?: string,
  effort?: InvokeAgyOptions['effort']
): { model: string; effort?: InvokeAgyOptions['effort'] } {
  let effectiveModel = (model || DEFAULT_MODELS.agy.model).trim();
  let effectiveEffort = effort;

  const thinkingMatch = effectiveModel.match(/^(.*?)-thinking$/i);
  if (thinkingMatch) {
    effectiveModel = thinkingMatch[1].trim();
    if (!effectiveEffort) effectiveEffort = 'high';
  }
  const neonMatch = effectiveModel.match(/^(?:gemini[ -]?)?(4)[ -]?neon(?:\s*\((xhigh|high|medium|low)\)|[ -](xhigh|high|medium|low))?$/i);
  if (neonMatch) {
    effectiveModel = `gemini-${neonMatch[1]}-neon`;
    const effortPart = neonMatch[2] || neonMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const argonMatch = effectiveModel.match(/^(?:gemini[ -]?)?(4)[ -]?argon(?:\s*\((high|medium|low)\)|[ -](high|medium|low))?$/i);
  if (argonMatch) {
    effectiveModel = `gemini-${argonMatch[1]}-argon`;
    const effortPart = argonMatch[2] || argonMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const hydrogenMatch = effectiveModel.match(/^(?:gemini[ -]?)?(4)[ -]?hydrogen(?:\s*\((xhigh|high|medium|low)\)|[ -](xhigh|high|medium|low))?$/i);
  if (hydrogenMatch) {
    effectiveModel = `gemini-${hydrogenMatch[1]}-hydrogen`;
    const effortPart = hydrogenMatch[2] || hydrogenMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const orchestratorNeonMatch = effectiveModel.match(/^(?:gemini[ -]?pro[ -]?orchestrator[ -]?neon|orchestrator(?:\s*\((?:gemini[ -]?4[ -]?)?neon\)|[ -](?:gemini[ -]?4[ -]?)?neon))$/i);
  if (orchestratorNeonMatch) {
    effectiveModel = 'gemini-pro-orchestrator-neon';
  }
  const orchestratorMatch = effectiveModel.match(/^(?:gemini[ -]?pro[ -]?orchestrator[ -]?g1[ -]?pro|orchestrator(?:\s*\(argon\)|[ -]argon)?)$/i);
  if (orchestratorMatch) {
    effectiveModel = 'gemini-pro-orchestrator-g1-pro';
  }
  const flashMatch = effectiveModel.match(/^(?:gemini[ -]?)?(3\.[5-8])[ -]?flash(?:\s*\((high|medium|low)\)|[ -](high|medium|low))?$/i);
  if (flashMatch) {
    effectiveModel = `gemini-${flashMatch[1]}-flash`;
    const effortPart = flashMatch[2] || flashMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const proMatch = effectiveModel.match(/^(?:gemini[ -]?)?(3\.1)[ -]?pro(?:\s*\((high|low)\)|[ -](high|low))?$/i);
  if (proMatch) {
    effectiveModel = 'gemini-3.1-pro';
    const effortPart = proMatch[2] || proMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const claudeMatch = effectiveModel.match(/^(?:claude[ -]?)?(opus|sonnet)[ -]?(?:5\.5|5-5)(?:\s*\((high|medium|low)\)|[ -](high|medium|low))?$/i);
  if (claudeMatch) {
    effectiveModel = `claude-${claudeMatch[1].toLowerCase()}-5-5`;
    const effortPart = claudeMatch[2] || claudeMatch[3];
    if (effortPart && !effectiveEffort) effectiveEffort = effortPart.toLowerCase() as InvokeAgyOptions['effort'];
  }
  const gptOssMatch = effectiveModel.match(/^gpt[ -]?oss[ -]?120b(?:\s*\(medium\)|[ -]medium)?$/i);
  if (gptOssMatch) {
    effectiveModel = 'gpt-oss-120b-medium';
  }

  if (NO_EFFORT_MODELS.has(effectiveModel)) {
    effectiveEffort = undefined;
  } else if (!effectiveEffort) {
    effectiveEffort = DEFAULT_MODELS.agy.effort;
  }

  return { model: effectiveModel, effort: effectiveEffort };
}

export function resolveAgyAcpModelId(
  model?: string,
  effort?: InvokeAgyOptions['effort']
): string {
  const normalized = normalizeAgyModelAndEffort(model, effort);
  if (!normalized.effort) return normalized.model;
  return `${normalized.model}-${normalized.effort}`;
}

export async function invokeAgy(options: InvokeAgyOptions): Promise<ExecutionResult> {
  if (options.signal?.aborted) {
    return { exitCode: EXIT_CODES.CANCELLED, stdout: '', stderr: 'Invocation cancelled.', durationMs: 0, cancelled: true };
  }
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

  const acpModelId = resolveAgyAcpModelId(options.model, options.effort);

  const args: string[] = ['acp', '--stdio'];
  // A headless child has no terminal to answer a permission prompt on, so a
  // prompt is a hang, not a safety net. Work stays bounded by workDir/addDirs.
  if (options.skipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  // AGY does not treat its cwd as a workspace: without --add-dir it runs with
  // "No active workspace", cannot resolve relative paths, and wanders the drives.
  const workDir = path.resolve(options.workDir || process.cwd());
  const workspaceDirs = [workDir, ...(options.addDirs || []).filter(Boolean).map((d) => path.resolve(d))];
  for (const d of new Set(workspaceDirs)) {
    args.push('--add-dir', d);
  }

  const timeoutMs = options.timeoutSec ? options.timeoutSec * 1000 : 0;
  const result = await runAcpPrompt({
    executable,
    args,
    cwd: workDir,
    modelId: acpModelId,
    modeId: effectiveMode,
    prompt: options.prompt,
    skipPermissions: options.skipPermissions,
    timeoutMs,
    signal: options.signal,
    onProgress: () => options.onProgress?.('agy'),
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

  // Quota/credit exhaustion (e.g. RESOURCE_EXHAUSTED 429) lets the dispatcher fail over.
  if (result.exitCode !== 0 && isQuotaExhausted(combinedOutput)) {
    return {
      ...result,
      exitCode: EXIT_CODES.QUOTA_EXCEEDED,
      output: combinedOutput.trim(),
      stderr: `Antigravity quota exhausted (Exit 10):\n${combinedOutput}`,
    };
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
