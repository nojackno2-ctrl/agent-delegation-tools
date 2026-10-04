import * as fs from 'node:fs';
import { jobRegistry } from './services/jobs/job-registry.js';
import { createProgressReporter } from './tools/execution.js';
import { getJobStatusSchema, getJobResultSchema, cancelJobSchema, handleGetJobStatus, handleGetJobResult, handleCancelJob } from './tools/jobs.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DEFAULT_MODELS } from './core/defaults.js';

import {
  getAgentQuotasSchema,
  handleGetAgentQuotas,
} from './tools/quota.js';
import {
  delegateTaskSchema,
  handleDelegateTask,
  delegateParallelSchema,
  handleDelegateParallel,
} from './tools/delegate.js';
import {
  invokeAgySchema,
  handleInvokeAgy,
  invokeCodexSchema,
  handleInvokeCodex,
  invokeClaudeSchema,
  handleInvokeClaude,
} from './tools/invokers.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_VERSION: string = pkg.version || '1.1.0';

/**
 * Sent to the host agent on connect. This is the contract that makes the parent
 * a dispatcher rather than a worker.
 */
const DELEGATION_POLICY = `Delegation-first policy for this workspace.

The parent agent is a dispatcher. Real work belongs to the three subscription
CLIs behind these tools, and the two external ones carry the load:

  - agy    -> Google Antigravity, ${DEFAULT_MODELS.agy.model}, effort ${DEFAULT_MODELS.agy.effort} (default)
  - codex  -> OpenAI Codex CLI, ${DEFAULT_MODELS.codex.model}, effort ${DEFAULT_MODELS.codex.effort} (default)
  - claude -> Claude CLI, ${DEFAULT_MODELS.claude.model}, effort ${DEFAULT_MODELS.claude.effort} (default)

Rules:
1. Delegate instead of doing it yourself. Multi-file implementation, refactors,
   scaffolding, bulk edits, whole-codebase reading, test writing, and research
   sweeps go through delegate_task / delegate_parallel. Do not spawn Claude
   subagents for work an external CLI can do.
2. Prefer the external CLIs. The claude backend spends the SAME subscription
   quota as the parent, so it offloads context but not quota; auto-routing never
   picks it. Reach for it only when explicitly asked or when agy and codex are
   both depleted.
3. Let quota drive routing. balance_quota is on by default: live quotas for all
   three CLIs are read before dispatch (10s cache) and a depleted provider is
   skipped and failed over automatically. Call get_agent_quotas when the user
   asks about remaining usage.
4. Subagents run with workspace-write by default, allowing delegated agents to
   read and modify files under work_dir without interactive permission prompts.
   Use read-only when the task is analysis-only. Sandbox reality: only Codex
   enforces an OS sandbox for workspace-write; AGY and Claude CLI write modes
   skip permission prompts and are NOT confined to work_dir.
5. Always pass work_dir (absolute path) so the subagent lands in the right repo.
6. Batch independent units through delegate_parallel; it spreads them round-robin
   across the external CLIs with per-task quota failover.
7. Async flow: delegate_task and delegate_parallel default to async=true, returning
   a job_id immediately. Poll get_job_result(job_id, wait_sec=25) until finished.
   invoke_* defaults to async=false for synchronous work; pass async=true for
   longer tasks. get_job_status lists jobs, and cancel_job aborts running tasks.
   Finished jobs are kept for one hour, up to 50; running jobs last until completion.
   同步呼叫可用 async=false；長任務先派工，再輪詢 get_job_result，避免主機逾時。`;

// Helper to convert Zod schema to clean JSON Schema for MCP tools
function toToolSchema(zodSchema: any) {
  // Simple JSON schema conversion for tool input
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' }) as any;
  return {
    type: 'object',
    properties: jsonSchema.properties || {},
    required: jsonSchema.required || [],
  };
}

async function main() {
  const server = new Server(
    {
      name: 'agent-delegation-mcp-server',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: DELEGATION_POLICY,
    }
  );

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_job_status',
          description: 'Get brief job status; omit job_id to list retained jobs.',
          inputSchema: toToolSchema(getJobStatusSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'get_job_result',
          description: 'Poll a job for status and result; wait_sec defaults to 25, maximum 50 seconds. Repeat while running.',
          inputSchema: toToolSchema(getJobResultSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'cancel_job',
          description: 'Abort a running job and terminate its child process tree.',
          inputSchema: toToolSchema(cancelJobSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'get_agent_quotas',
          description:
            'Read live 7-day subscription quotas, shorter rate-limit windows, and login state for all three CLIs (Antigravity, Codex, Claude) without starting a model turn. AGY uses the official /usage slash command. 10-second cache.',
          inputSchema: toToolSchema(getAgentQuotasSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'delegate_task',
          description:
            `Defaults to async=true: returns job_id; poll get_job_result for completion. PREFERRED way to get work done: hand a task to an external subagent CLI instead of doing it in the parent agent. Auto-routes by task type and live quota (agy = ${DEFAULT_MODELS.agy.model} ${DEFAULT_MODELS.agy.effort}, codex = ${DEFAULT_MODELS.codex.model} ${DEFAULT_MODELS.codex.effort}), fails over when a provider is depleted, and runs write-capable by default so the subagent edits files under work_dir without any approval prompt.`,
          inputSchema: toToolSchema(delegateTaskSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'delegate_parallel',
          description:
            'Defaults to async=true: returns job_id; poll get_job_result for completion. Run a batch of independent tasks concurrently, spread round-robin across the external CLIs with quota-aware failover. Use for multi-component builds, per-file refactors, and fan-out research.',
          inputSchema: toToolSchema(delegateParallelSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'invoke_agy',
          description:
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the Google Antigravity (AGY) CLI subagent. Defaults: ${DEFAULT_MODELS.agy.model}, effort ${DEFAULT_MODELS.agy.effort}, accept-edits mode with permission prompts skipped.`,
          inputSchema: toToolSchema(invokeAgySchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'invoke_codex',
          description:
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the OpenAI Codex CLI subagent. Defaults: ${DEFAULT_MODELS.codex.model}, effort ${DEFAULT_MODELS.codex.effort}, workspace-write sandbox with approvals auto-handled. Handles non-ASCII Windows paths via junction aliases.`,
          inputSchema: toToolSchema(invokeCodexSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'invoke_claude',
          description:
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the Anthropic Claude CLI subagent (${DEFAULT_MODELS.claude.model}, effort ${DEFAULT_MODELS.claude.effort}) with token-isolated context (--safe-mode) and session resume. Last resort: it spends the same subscription quota as the parent agent, so prefer invoke_agy / invoke_codex.`,
          inputSchema: toToolSchema(invokeClaudeSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ],
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;

    const reporter = createProgressReporter(request.params._meta?.progressToken, notification => extra.sendNotification(notification), name);
    const context = { signal: extra.signal, onProgress: reporter.onProgress };
    try {
      switch (name) {
        case 'get_job_status': return handleGetJobStatus(getJobStatusSchema.parse(args));
        case 'get_job_result': return await handleGetJobResult(getJobResultSchema.parse(args));
        case 'cancel_job': return await handleCancelJob(cancelJobSchema.parse(args));
        case 'get_agent_quotas': {
          const parsed = getAgentQuotasSchema.parse(args);
          return await handleGetAgentQuotas(parsed);
        }
        case 'delegate_task': {
          const parsed = delegateTaskSchema.parse(args);
          return await handleDelegateTask(parsed, context);
        }
        case 'delegate_parallel': {
          const parsed = delegateParallelSchema.parse(args);
          return await handleDelegateParallel(parsed, context);
        }
        case 'invoke_agy': {
          const parsed = invokeAgySchema.parse(args);
          return await handleInvokeAgy(parsed, context);
        }
        case 'invoke_codex': {
          const parsed = invokeCodexSchema.parse(args);
          return await handleInvokeCodex(parsed, context);
        }
        case 'invoke_claude': {
          const parsed = invokeClaudeSchema.parse(args);
          return await handleInvokeClaude(parsed, context);
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error: any) {
      if (error instanceof McpError) {
        throw error;
      }
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool execution failed (${name}): ${error?.message || String(error)}`,
          },
        ],
      };
    } finally {
      reporter.stop();
    }
  });

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await jobRegistry.abortAll();
    await server.close();
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('close', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP Server error:', err);
  process.exit(1);
});
