import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
import {
  startJob,
  getJob,
  listJobs,
  waitForJob,
  clampWaitSec,
  runningMessage,
  DEFAULT_WAIT_SEC,
  MAX_WAIT_SEC,
  Job,
  ToolResult,
} from './services/jobs/job-store.js';

/**
 * Sent to the host agent on connect. This is the contract that makes the parent
 * a dispatcher rather than a worker.
 */
const DELEGATION_POLICY = `Delegation-first policy for this workspace.

The parent agent is a dispatcher. Real work belongs to the three subscription
CLIs behind these tools, and the two external ones carry the load:

  - agy    -> Google Antigravity, gemini-3.8-flash, effort medium (default)
  - codex  -> OpenAI Codex CLI, gpt-6-luna, effort medium (default)
  - claude -> Claude CLI, claude-sonnet-5, effort medium (default)

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
4. Subagents already have permission. sandbox defaults to workspace-write, so
   delegated agents read and write files under work_dir with no approval step.
   Never ask the user to authorize a subagent's file access; pass read-only only
   when the task is genuinely analysis-only.
5. Always pass work_dir (absolute path) so the subagent lands in the right repo.
6. Batch independent units through delegate_parallel; it spreads them round-robin
   across the external CLIs.
7. Long tasks return a job id. A delegation still running after wait_sec
   (default ${DEFAULT_WAIT_SEC}s, below the client's 60s request timeout) returns
   "[Job <id> still running]". The subagent keeps working; call
   get_delegation_result with that job_id (repeatedly) to collect the result.
   Never re-submit the same task because of that message.`;

// Helper to convert Zod schema to clean JSON Schema for MCP tools
function toToolSchema(zodSchema: any, extraProperties: Record<string, unknown> = {}) {
  // Simple JSON schema conversion for tool input
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' }) as any;
  return {
    type: 'object',
    properties: { ...(jsonSchema.properties || {}), ...extraProperties },
    required: jsonSchema.required || [],
  };
}

const WAIT_SEC_PROPERTY = {
  wait_sec: {
    type: 'number',
    minimum: 0,
    maximum: MAX_WAIT_SEC,
    default: DEFAULT_WAIT_SEC,
    description: `Seconds to wait inline before returning a job id (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}). The subagent keeps running afterwards; collect it with get_delegation_result.`,
  },
};

/** Tools that start a subagent and can outlive the client's request timeout. */
const LONG_RUNNING_SCHEMAS: Record<string, { parse: (args: unknown) => any }> = {
  delegate_task: delegateTaskSchema,
  delegate_parallel: delegateParallelSchema,
  invoke_agy: invokeAgySchema,
  invoke_codex: invokeCodexSchema,
  invoke_claude: invokeClaudeSchema,
};

async function runLongTool(name: string, parsed: any): Promise<ToolResult> {
  switch (name) {
    case 'delegate_task':
      return (await handleDelegateTask(parsed)) as ToolResult;
    case 'delegate_parallel':
      return (await handleDelegateParallel(parsed)) as ToolResult;
    case 'invoke_agy':
      return (await handleInvokeAgy(parsed)) as ToolResult;
    case 'invoke_codex':
      return (await handleInvokeCodex(parsed)) as ToolResult;
    default:
      return (await handleInvokeClaude(parsed)) as ToolResult;
  }
}

function summarize(args: Record<string, unknown>): string {
  const agent = typeof args.agent === 'string' ? args.agent : 'auto';
  const text = Array.isArray(args.tasks)
    ? `${args.tasks.length} parallel task(s)`
    : String(args.prompt ?? '').replace(/\s+/g, ' ');
  return `[${agent}] ${text.length > 80 ? text.slice(0, 77) + '...' : text}`;
}

function jobListText(jobs: Job[]): string {
  if (jobs.length === 0) return 'No delegation jobs in this server session.';
  return jobs
    .map((j) => {
      const secs = Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000);
      return `${j.id}  ${j.status.padEnd(9)} ${secs}s  ${j.tool}: ${j.summary}`;
    })
    .join('\n');
}

async function main() {
  const server = new Server(
    {
      name: 'agent-delegation-mcp-server',
      version: '1.0.0',
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
          name: 'get_agent_quotas',
          description:
            'Read live 7-day subscription quotas, shorter rate-limit windows, and login state for all three CLIs (Antigravity, Codex, Claude) without starting a model turn. AGY uses the official /usage slash command. 10-second cache.',
          inputSchema: toToolSchema(getAgentQuotasSchema),
        },
        {
          name: 'delegate_task',
          description:
            'PREFERRED way to get work done: hand a task to an external subagent CLI instead of doing it in the parent agent. Auto-routes by task type and live quota (agy = Gemini 3.8 Flash medium, codex = GPT-6-Luna medium), fails over when a provider is depleted, and runs write-capable by default so the subagent edits files under work_dir without any approval prompt.',
          inputSchema: toToolSchema(delegateTaskSchema, WAIT_SEC_PROPERTY),
        },
        {
          name: 'delegate_parallel',
          description:
            'Run a batch of independent tasks concurrently, spread round-robin across the external CLIs with quota-aware failover. Use for multi-component builds, per-file refactors, and fan-out research.',
          inputSchema: toToolSchema(delegateParallelSchema, WAIT_SEC_PROPERTY),
        },
        {
          name: 'get_delegation_result',
          description:
            'Wait for and collect the result of a delegation that returned "[Job <id> still running]". Waits up to wait_sec, then returns the subagent output or reports it is still running (call again). Omit job_id to list jobs.',
          inputSchema: {
            type: 'object',
            properties: {
              job_id: { type: 'string', description: 'Job id returned by a delegation tool. Omit to list jobs.' },
              ...WAIT_SEC_PROPERTY,
            },
            required: [],
          },
        },
        {
          name: 'invoke_agy',
          description:
            'Directly invoke the Google Antigravity (AGY) CLI subagent. Defaults: gemini-3.8-flash, effort medium, accept-edits mode with permission prompts skipped.',
          inputSchema: toToolSchema(invokeAgySchema, WAIT_SEC_PROPERTY),
        },
        {
          name: 'invoke_codex',
          description:
            'Directly invoke the OpenAI Codex CLI subagent. Defaults: gpt-6-luna, effort medium, workspace-write sandbox with approvals auto-handled. Handles non-ASCII Windows paths via junction aliases.',
          inputSchema: toToolSchema(invokeCodexSchema, WAIT_SEC_PROPERTY),
        },
        {
          name: 'invoke_claude',
          description:
            'Directly invoke the Anthropic Claude CLI subagent (claude-sonnet-5, effort medium) with token-isolated context (--safe-mode) and session resume. Last resort: it spends the same subscription quota as the parent agent, so prefer invoke_agy / invoke_codex.',
          inputSchema: toToolSchema(invokeClaudeSchema, WAIT_SEC_PROPERTY),
        },
      ],
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const progressToken = request.params._meta?.progressToken;

    // Progress notifications keep clients that reset their timeout on progress alive.
    const waitWithProgress = (job: Job, waitSec: number) =>
      waitForJob(
        job,
        waitSec,
        (elapsedSec) => {
          if (progressToken === undefined) return;
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: elapsedSec, message: `${job.id} running ${elapsedSec}s` },
            })
            .catch(() => {});
        },
        extra.signal
      );

    try {
      const longSchema = LONG_RUNNING_SCHEMAS[name];
      if (longSchema) {
        const { wait_sec, ...toolArgs } = args as Record<string, unknown>;
        // Parse before starting so invalid input fails the call, not a background job.
        const parsed = longSchema.parse(toolArgs);
        const job = startJob(name, summarize(toolArgs), () => runLongTool(name, parsed));
        const done = await waitWithProgress(job, clampWaitSec(wait_sec as number | undefined));
        return done && job.result ? job.result : runningMessage(job);
      }

      switch (name) {
        case 'get_agent_quotas': {
          const parsed = getAgentQuotasSchema.parse(args);
          return await handleGetAgentQuotas(parsed);
        }
        case 'get_delegation_result': {
          const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
          if (!jobId) {
            return { content: [{ type: 'text', text: jobListText(listJobs()) }] };
          }
          const job = getJob(jobId);
          if (!job) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Unknown job_id "${jobId}". Jobs live in server memory; a restarted MCP server forgets them.\n\n${jobListText(listJobs())}`,
                },
              ],
            };
          }
          const done = await waitWithProgress(job, clampWaitSec(args.wait_sec as number | undefined));
          return done && job.result ? job.result : runningMessage(job);
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
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP Server error:', err);
  process.exit(1);
});
