import { z } from 'zod';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { invokeCodex } from '../services/invokers/codex-invoker.js';
import { invokeClaude } from '../services/invokers/claude-invoker.js';
import { DEFAULT_MODELS } from '../core/defaults.js';

// --- Antigravity (AGY) Invoker ---
export const invokeAgySchema = z.object({
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
    .describe('Model name. Defaults to gemini-3.7-flash; gemini-3.1-pro for deep architecture work.'),
  effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .default(DEFAULT_MODELS.agy.effort)
    .describe('Thinking effort. Defaults to high.'),
  work_dir: z.string().optional().describe('Working directory.'),
  timeout_sec: z.number().int().min(10).max(3600).optional().default(900),
});

export type InvokeAgyInput = z.infer<typeof invokeAgySchema>;

export async function handleInvokeAgy(input: InvokeAgyInput) {
  try {
    const result = await invokeAgy({
      prompt: input.prompt,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      workDir: input.work_dir,
      timeoutSec: input.timeout_sec,
    });

    const textOutput = result.output || result.stdout || result.stderr;
    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: `AGY subagent failed (Exit ${result.exitCode}):\n${result.stderr || textOutput}` }],
      };
    }

    return { content: [{ type: 'text', text: textOutput.trim() || 'AGY subagent completed.' }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `AGY invocation error: ${error?.message || String(error)}` }] };
  }
}

// --- Codex Invoker ---
export const invokeCodexSchema = z.object({
  prompt: z.string().min(1).describe('Instruction or task for Codex subagent.'),
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('workspace-write')
    .describe(
      'Codex sandbox permission boundary. Defaults to workspace-write: the subagent edits files under work_dir and approvals are auto-handled, so the run never blocks on a prompt.'
    ),
  model: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.codex.model)
    .describe('Model for Codex CLI. Defaults to gpt-5.6-luna.'),
  effort: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.codex.effort)
    .describe('Reasoning effort (low|medium|high|xhigh|max). Defaults to high.'),
  work_dir: z.string().optional().describe('Working directory.'),
  timeout_sec: z.number().int().min(10).max(3600).optional().default(900),
});

export type InvokeCodexInput = z.infer<typeof invokeCodexSchema>;

export async function handleInvokeCodex(input: InvokeCodexInput) {
  try {
    const result = await invokeCodex({
      prompt: input.prompt,
      sandbox: input.sandbox,
      model: input.model,
      effort: input.effort,
      workDir: input.work_dir,
      timeoutSec: input.timeout_sec,
    });

    const textOutput = result.output || result.stdout || result.stderr;
    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Codex subagent failed (Exit ${result.exitCode}):\n${result.stderr || textOutput}` }],
      };
    }

    return { content: [{ type: 'text', text: textOutput.trim() || 'Codex subagent completed.' }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `Codex invocation error: ${error?.message || String(error)}` }] };
  }
}

// --- Claude Code Invoker ---
export const invokeClaudeSchema = z.object({
  prompt: z.string().min(1).describe('Instruction or task for Claude Code subagent.'),
  mode: z
    .enum(['plan', 'accept-edits', 'read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .default('workspace-write')
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
    .describe('Model. Defaults to claude-sonnet-5.'),
  effort: z
    .string()
    .optional()
    .default(DEFAULT_MODELS.claude.effort)
    .describe('Effort level (low|medium|high|xhigh|max). Defaults to high.'),
  session_id: z.string().optional().describe('Resume or fork a previous session ID.'),
  resume: z.boolean().optional().describe('Resume the session specified by session_id.'),
  work_dir: z.string().optional().describe('Working directory.'),
  timeout_sec: z.number().int().min(10).max(3600).optional().default(900),
});

export type InvokeClaudeInput = z.infer<typeof invokeClaudeSchema>;

export async function handleInvokeClaude(input: InvokeClaudeInput) {
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
      timeoutSec: input.timeout_sec,
    });

    const textOutput = result.output || result.stdout || result.stderr;
    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Claude subagent failed (Exit ${result.exitCode}):\n${result.stderr || textOutput}` }],
      };
    }

    return { content: [{ type: 'text', text: textOutput.trim() || 'Claude subagent completed.' }] };
  } catch (error: any) {
    return { isError: true, content: [{ type: 'text', text: `Claude invocation error: ${error?.message || String(error)}` }] };
  }
}
