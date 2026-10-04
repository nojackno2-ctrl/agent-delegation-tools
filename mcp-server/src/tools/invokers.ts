import { dispatchJob, ToolContext, ToolResponse } from './execution.js';
import { z } from 'zod';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { invokeCodex } from '../services/invokers/codex-invoker.js';
import { invokeClaude } from '../services/invokers/claude-invoker.js';
import { DEFAULT_MODELS, DEFAULT_SANDBOX } from '../core/defaults.js';
import { capOutputTail, generateRunId, writeRunLog } from '../core/logging.js';
import { validateWorkDir } from '../utils/validation.js';

// --- Antigravity (AGY) Invoker ---
export const invokeAgySchema = z.object({
  async: z.boolean().optional().default(false).describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  prompt: z.string().min(1).describe('Instruction or task for Antigravity subagent.'),
  mode: z
    .enum(['plan', 'accept-edits', 'read-only', 'workspace-write'])
    .optional()
    .default('accept-edits')
    .describe(
      'AGY execution mode. Defaults to accept-edits: the subagent may create and modify files in work_dir without asking. Use plan/read-only for analysis only.'
    ),
  model: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.agy.model)
    .describe(`Model name. Defaults to ${DEFAULT_MODELS.agy.model}; gemini-3.1-pro for deep architecture work.`),
  effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .default(DEFAULT_MODELS.agy.effort)
    .describe(`Thinking effort. Defaults to ${DEFAULT_MODELS.agy.effort}.`),
  work_dir: z.string().min(1).describe('Absolute path to existing working directory.'),
  timeout_sec: z.number().int().min(0).max(86400).optional().default(0).describe('Optional timeout in seconds. Default 0 = no limit.'),
});

export type InvokeAgyInput = z.input<typeof invokeAgySchema>;

export async function handleInvokeAgy(rawInput: InvokeAgyInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return { isError: true, content: [{ type: 'text', text: dirCheck.error! }] };
  }

  const input = invokeAgySchema.parse(rawInput);
  if (input.async) return dispatchJob('invoke_agy', jobContext => handleInvokeAgy({ ...input, async: false }, jobContext));
  try {
    const result = await invokeAgy({
      prompt: input.prompt,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      workDir: input.work_dir,
      signal: context.signal,
      onProgress: context.onProgress,
      timeoutSec: input.timeout_sec,
    });

    const runId = generateRunId();
    const logPath = writeRunLog(runId, 'agy', result.stdout, result.stderr);
    result.logPath = logPath;

    context.onResult?.({ exitCode: result.exitCode, usedAgent: 'agy', logPath });
    const textOutput = result.output || result.stdout || result.stderr;
    const logLine = `Log: ${logPath}\n\n`;

    if (result.exitCode !== 0) {
      const parts: string[] = [];
      if (result.stdout && result.stdout.trim()) parts.push(`Stdout:\n${capOutputTail(result.stdout, 10000, logPath)}`);
      if (result.stderr && result.stderr.trim()) parts.push(`Stderr:\n${capOutputTail(result.stderr, 10000, logPath)}`);
      const failureDetails = parts.length > 0 ? parts.join('\n\n') : (capOutputTail(textOutput, 10000, logPath) || 'No output recorded.');
      return {
        isError: true,
        content: [{ type: 'text', text: `AGY subagent failed (Exit ${result.exitCode}):\n${logLine}${failureDetails}` }],
      };
    }

    return { content: [{ type: 'text', text: `${logLine}${capOutputTail(textOutput, 20000, logPath).trim() || 'AGY subagent completed.'}` }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `AGY invocation error: ${error?.message || String(error)}` }] };
  }
}

// --- Codex Invoker ---
export const invokeCodexSchema = z.object({
  async: z.boolean().optional().default(false).describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  prompt: z.string().min(1).describe('Instruction or task for Codex subagent.'),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default(DEFAULT_SANDBOX)
    .describe(
      'Codex sandbox permission boundary. Defaults to workspace-write: the subagent edits files under work_dir and approvals are auto-handled, so the run never blocks on a prompt.'
    ),
  model: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.codex.model)
    .describe(`Model for Codex CLI. Defaults to ${DEFAULT_MODELS.codex.model}.`),
  effort: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.codex.effort)
    .describe(`Reasoning effort (low|medium|high|xhigh|max). Defaults to ${DEFAULT_MODELS.codex.effort}.`),
  work_dir: z.string().min(1).describe('Absolute path to existing working directory.'),
  timeout_sec: z.number().int().min(0).max(86400).optional().default(0).describe('Optional timeout in seconds. Default 0 = no limit.'),
});

export type InvokeCodexInput = z.input<typeof invokeCodexSchema>;

export async function handleInvokeCodex(rawInput: InvokeCodexInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return { isError: true, content: [{ type: 'text', text: dirCheck.error! }] };
  }

  const input = invokeCodexSchema.parse(rawInput);
  if (input.async) return dispatchJob('invoke_codex', jobContext => handleInvokeCodex({ ...input, async: false }, jobContext));
  try {
    const result = await invokeCodex({
      prompt: input.prompt,
      sandbox: input.sandbox,
      model: input.model,
      effort: input.effort,
      workDir: input.work_dir,
      signal: context.signal,
      onProgress: context.onProgress,
      timeoutSec: input.timeout_sec,
    });

    const runId = generateRunId();
    const logPath = writeRunLog(runId, 'codex', result.stdout, result.stderr);
    result.logPath = logPath;

    context.onResult?.({ exitCode: result.exitCode, usedAgent: 'codex', logPath });
    const textOutput = result.output || result.stdout || result.stderr;
    const logLine = `Log: ${logPath}\n\n`;

    if (result.exitCode !== 0) {
      const parts: string[] = [];
      if (result.stdout && result.stdout.trim()) parts.push(`Stdout:\n${capOutputTail(result.stdout, 10000, logPath)}`);
      if (result.stderr && result.stderr.trim()) parts.push(`Stderr:\n${capOutputTail(result.stderr, 10000, logPath)}`);
      const failureDetails = parts.length > 0 ? parts.join('\n\n') : (capOutputTail(textOutput, 10000, logPath) || 'No output recorded.');
      return {
        isError: true,
        content: [{ type: 'text', text: `Codex subagent failed (Exit ${result.exitCode}):\n${logLine}${failureDetails}` }],
      };
    }

    return { content: [{ type: 'text', text: `${logLine}${capOutputTail(textOutput, 20000, logPath).trim() || 'Codex subagent completed.'}` }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `Codex invocation error: ${error?.message || String(error)}` }] };
  }
}

// --- Claude Code Invoker ---
export const invokeClaudeSchema = z.object({
  async: z.boolean().optional().default(false).describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  prompt: z.string().min(1).describe('Instruction or task for Claude Code subagent.'),
  mode: z
    .enum(['plan', 'accept-edits', 'read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default(DEFAULT_SANDBOX)
    .describe(
      'Permission mode. Defaults to workspace-write, which runs the headless child unattended (no permission prompts) inside work_dir. Note: this backend spends the same Claude subscription quota as the parent, so prefer invoke_agy / invoke_codex.'
    ),
  context: z
    .enum(['isolated', 'project'])
    .optional()
    .default('isolated')
    .describe('Context mode: "isolated" uses --safe-mode (90%+ token reduction), "project" loads project CLAUDE.md/tools.'),
  model: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.claude.model)
    .describe(`Model. Defaults to ${DEFAULT_MODELS.claude.model}.`),
  effort: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.claude.effort)
    .describe(`Effort level (low|medium|high|xhigh|max). Defaults to ${DEFAULT_MODELS.claude.effort}.`),
  session_id: z.string().optional().describe('Resume or fork a previous session ID.'),
  resume: z.boolean().optional().describe('Resume the session specified by session_id.'),
  work_dir: z.string().min(1).describe('Absolute path to existing working directory.'),
  timeout_sec: z.number().int().min(0).max(86400).optional().default(0).describe('Optional timeout in seconds. Default 0 = no limit.'),
});

export type InvokeClaudeInput = z.input<typeof invokeClaudeSchema>;

export async function handleInvokeClaude(rawInput: InvokeClaudeInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return { isError: true, content: [{ type: 'text', text: dirCheck.error! }] };
  }

  const input = invokeClaudeSchema.parse(rawInput);
  if (input.async) return dispatchJob('invoke_claude', jobContext => handleInvokeClaude({ ...input, async: false }, jobContext));
  try {
    const result = await invokeClaude({
      prompt: input.prompt,
      mode: input.mode,
      context: input.context,
      model: input.model,
      effort: input.effort,
      sessionId: input.session_id,
      resume: input.resume,
      workDir: input.work_dir,
      signal: context.signal,
      onProgress: context.onProgress,
      timeoutSec: input.timeout_sec,
    });

    const runId = generateRunId();
    const logPath = writeRunLog(runId, 'claude', result.stdout, result.stderr);
    result.logPath = logPath;

    context.onResult?.({ exitCode: result.exitCode, usedAgent: 'claude', logPath });
    const textOutput = result.output || result.stdout || result.stderr;
    const logLine = `Log: ${logPath}\n\n`;

    if (result.exitCode !== 0) {
      const parts: string[] = [];
      if (result.stdout && result.stdout.trim()) parts.push(`Stdout:\n${capOutputTail(result.stdout, 10000, logPath)}`);
      if (result.stderr && result.stderr.trim()) parts.push(`Stderr:\n${capOutputTail(result.stderr, 10000, logPath)}`);
      const failureDetails = parts.length > 0 ? parts.join('\n\n') : (capOutputTail(textOutput, 10000, logPath) || 'No output recorded.');
      return {
        isError: true,
        content: [{ type: 'text', text: `Claude subagent failed (Exit ${result.exitCode}):\n${logLine}${failureDetails}` }],
      };
    }

    return { content: [{ type: 'text', text: `${logLine}${capOutputTail(textOutput, 20000, logPath).trim() || 'Claude subagent completed.'}` }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `Claude invocation error: ${error?.message || String(error)}` }] };
  }
}
