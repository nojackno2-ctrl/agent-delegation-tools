import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_LOCAL_MODEL } from '../core/defaults.js';
import { EXIT_CODES } from '../core/types.js';
import { invokeLocal, listLocalModels } from '../services/invokers/local-invoker.js';
import { dispatchJob, ToolContext, ToolResponse } from './execution.js';

export const invokeLocalSchema = z.object({
  async: z.boolean().default(false).describe('Return a job_id immediately; poll get_job_result until finished.'),
  task: z.string().min(1).max(8000).refine(task => !!task.trim(), 'task must contain non-whitespace text'),
  context: z.string().max(64000).default('').describe('Supply all required context; local models cannot read files or run tools.'),
  model: z.string().optional().default(DEFAULT_LOCAL_MODEL),
  max_tokens: z.number().int().min(32).max(4096).default(1024),
  max_output_chars: z.number().int().min(128).max(16000).default(6000),
  think: z.boolean().default(true).describe('Enable reasoning for supported models; false is faster for trivial tasks.'),
  timeout_sec: z.number().int().min(0).max(3600).optional().describe('Timeout including queue wait; 0 means no limit. Default 300, or 1800 with work_dir.'),
  work_dir: z.string().refine(dir => path.isAbsolute(dir), 'work_dir must be an absolute path').optional()
    .describe('Absolute existing directory. Enables the file-tool agent loop: the local model can list, read and search files, and with workspace-write also write, edit and delete them. Paths are confined to work_dir in Node; there is no shell tool.'),
  sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write').describe('With work_dir: read-only exposes only list/read/search tools. Ignored without work_dir.'),
  max_steps: z.number().int().min(1).max(100).default(30).describe('With work_dir: maximum model turns in the tool loop.'),
});
export const listLocalModelsSchema = z.object({});

export async function handleInvokeLocal(rawInput: z.input<typeof invokeLocalSchema>, context: ToolContext = {}): Promise<ToolResponse> {
  const input = invokeLocalSchema.parse(rawInput);
  if (input.async) return dispatchJob('invoke_local', jobContext => handleInvokeLocal({ ...input, async: false }, jobContext));
  try {
    context.onProgress?.('local');
    const result = await invokeLocal({ task: input.task, context: input.context, model: input.model,
      maxTokens: input.max_tokens, maxOutputChars: input.max_output_chars, think: input.think,
      signal: context.signal, timeoutSec: input.timeout_sec ?? (input.work_dir ? 1800 : 300),
      workDir: input.work_dir, sandbox: input.sandbox, maxSteps: input.max_steps });
    context.onResult?.({ usedAgent: 'local', exitCode: 0 });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const exitCode = context.signal?.aborted ? EXIT_CODES.CANCELLED
      : error instanceof Error && error.name === 'TimeoutError' ? EXIT_CODES.TIMEOUT : EXIT_CODES.GENERIC_FAILURE;
    context.onResult?.({ usedAgent: 'local', exitCode });
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] };
  }
}

export async function handleListLocalModels(): Promise<ToolResponse> {
  return { content: [{ type: 'text', text: JSON.stringify(await listLocalModels()) }] };
}
