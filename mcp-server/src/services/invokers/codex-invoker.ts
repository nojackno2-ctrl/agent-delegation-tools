import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveCodexExecutable } from '../../core/executables.js';
import { spawnProcess } from '../../core/process.js';
import { ensureAsciiDirectory } from '../../core/junction.js';
import { ExecutionResult, EXIT_CODES } from '../../core/types.js';
import { DEFAULT_MODELS, DEFAULT_SANDBOX } from '../../core/defaults.js';

export interface InvokeCodexOptions {
  prompt: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string;
  effort?: string;
  workDir?: string;
  addDirs?: string[];
  outFile?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (agent: string) => void;
  codexPath?: string;
  approveForMe?: boolean;
}

const ENVIRONMENT_SIGNATURE = 'helper_unknown_error|setup refresh had errors|Failed to create unified exec process|windows sandbox failed';

/**
 * True only when Codex itself reports that its execution environment failed:
 * a signature that starts a line or sits in its exec_command router error, and no
 * command in the transcript ever succeeded. Matching anywhere would misfire on file
 * contents Codex printed (e.g. a handoff note quoting these strings).
 */
export function isCodexEnvironmentFailure(transcript: string): boolean {
  if (/^\s*succeeded in \d+ms:/im.test(transcript)) return false;
  return new RegExp(`^\\s*(?:${ENVIRONMENT_SIGNATURE})|exec_command failed:.*(?:${ENVIRONMENT_SIGNATURE})`, 'im').test(transcript);
}

export async function invokeCodex(options: InvokeCodexOptions): Promise<ExecutionResult> {
  if (options.signal?.aborted) return { exitCode: EXIT_CODES.CANCELLED, stdout: '', stderr: 'Invocation cancelled.', durationMs: 0, cancelled: true };
  options.onProgress?.('codex');
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

  const sandbox = options.sandbox || DEFAULT_SANDBOX;
  const targetDir = options.workDir || process.cwd();
  const effectiveModel = options.model || DEFAULT_MODELS.codex.model;
  const effectiveEffort = options.effort || DEFAULT_MODELS.codex.effort;

  // Resolve ASCII directory via Junction if path contains non-ASCII characters
  const dirResolution = ensureAsciiDirectory(targetDir);

  const tempOutFile =
    options.outFile ||
    path.join(os.tmpdir(), `mcp-codex-out-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.txt`);

  const useAutomaticApproval = options.approveForMe !== false && sandbox === 'workspace-write';
  const args: string[] = [
    'exec',
    '--cd',
    dirResolution.effectivePath,
    '--color',
    'never',
    '--ephemeral',
    '--skip-git-repo-check',
    '--output-last-message',
    tempOutFile,
    '-m',
    effectiveModel,
    '-c',
    `model_reasoning_effort="${effectiveEffort}"`,
  ];

  // Current Codex CLI makes --approve-for-me imply workspace-write and rejects
  // combining it with an explicit --sandbox value. Read-only and explicitly
  // approval-disabled runs keep the direct sandbox flag.
  if (useAutomaticApproval) {
    args.push('--approve-for-me');
  } else {
    args.push('--sandbox', sandbox);
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

  // 0/undefined = no limit: long-running subagents are left to finish.
  const timeoutMs = (options.timeoutSec ?? 0) * 1000;

  try {
    const result = await spawnProcess({
      executable,
      args,
      cwd: dirResolution.effectivePath,
      timeoutMs,
      signal: options.signal,
      onStdout: () => options.onProgress?.('codex'),
      onStderr: () => options.onProgress?.('codex'),
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

    // Codex can exit zero after its execution environment failed to start.
    if (!result.cancelled && !result.timedOut && isCodexEnvironmentFailure(result.stdout + '\n' + result.stderr + '\n' + output)) {
      return { ...result, exitCode: EXIT_CODES.ENVIRONMENT_FAILURE, output: output.trim() };
    }

    if (result.cancelled || result.timedOut) return { ...result, output: output.trim() };

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
