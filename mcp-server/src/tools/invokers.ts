import { z } from 'zod';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { invokeCodex } from '../services/invokers/codex-invoker.js';
import { invokeClaude } from '../services/invokers/claude-invoker.js';

// --- Antigravity (AGY) Invoker ---
export const invokeAgySchema = z.object({
  prompt: z.string().min(1).describe('Instruction or task for Antigravity subagent.'),
  mode: z
    .enum(['plan', 'accept-edits', 'read-only', 'workspace-write'])
    .optional()
    .default('plan')
    .describe('AGY execution mode (plan = read-only analysis, accept-edits = code changes).'),
  model: z
    .string()
    .optional()
    .default('gemini-3.7-flash')
    .describe('Model name (e.g. gemini-3.7-flash, gemini-3.1-pro, claude-3-5-sonnet).'),
  effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .default('low')
    .describe('Thinking effort for models that support it.'),
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
    .default('read-only')
    .describe('Codex sandbox permission boundary.'),
  model: z.string().optional().describe('Model override for Codex CLI.'),
  effort: z.string().optional().describe('Reasoning effort level.'),
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
    .default('plan')
    .describe('Permission mode.'),
  context: z
    .enum(['isolated', 'project'])
    .optional()
    .default('isolated')
    .describe('Context mode: "isolated" uses --safe-mode (90%+ token reduction), "project" loads project CLAUDE.md/tools.'),
  model: z.string().optional().describe('Model override.'),
  effort: z.string().optional().describe('Effort level.'),
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
