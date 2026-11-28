import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DEFAULT_MODELS, ADVISOR_MODELS, DEFAULT_LOCAL_MODEL, getHostAgent, getExternalAgents } from './core/defaults.js';
import { AgentName } from './core/types.js';
import { invokeLocalSchema, listLocalModelsSchema, handleInvokeLocal, handleListLocalModels } from './tools/local.js';
import {
  configureAdvisorSchema,
  consultAdvisorSchema,
  handleConfigureAdvisor,
  handleConsultAdvisor,
} from './tools/advisor.js';

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
export function buildDelegationPolicy(hostAgent: AgentName = getHostAgent()): string {
  const [ext1, ext2] = getExternalAgents(hostAgent);
  const hostLabel =
    hostAgent === 'agy' ? 'Antigravity (AGY)' : hostAgent === 'codex' ? 'Codex' : 'Claude';

  const orchestratorRule =
    hostAgent === 'agy'
      ? `
11. AGY Orchestrator Mode (Plan + Execute):
    - Plan phase (read-only): Use consult_advisor (readOnlyHint=true; defaults to Codex ${ADVISOR_MODELS.codex.model} ${ADVISOR_MODELS.codex.effort} or Claude ${ADVISOR_MODELS.claude.model} ${ADVISOR_MODELS.claude.effort}) or delegate_task(sandbox="read-only", agent="codex"|"claude") for cross-provider architecture advice, second opinions, or codebase analysis without modifying files. Write execution plans that explicitly assign implementation, review, or parallel steps to Codex (delegate_task / invoke_codex) and Claude (delegate_task / invoke_claude) when appropriate.
    - Execute phase (write-capable): Carry out delegated steps via delegate_task, delegate_parallel, invoke_codex, invoke_claude, and consult_advisor (polling get_job_result for async jobs), then verify diffs and tests before handing back [plan review].`
      : '';

  return `Delegation-first policy for this workspace (active host: ${hostLabel}).

The parent agent is a dispatcher. Real work belongs to the three subscription
CLIs and a local backend behind these tools:

  - agy    -> Google Antigravity, ${DEFAULT_MODELS.agy.model}, effort ${DEFAULT_MODELS.agy.effort} (default)
  - codex  -> OpenAI Codex CLI, ${DEFAULT_MODELS.codex.model}, effort ${DEFAULT_MODELS.codex.effort} (default)
  - claude -> Claude CLI, ${DEFAULT_MODELS.claude.model}, effort ${DEFAULT_MODELS.claude.effort} (default)
  - local  -> Ollama ${DEFAULT_LOCAL_MODEL} on this machine, zero cloud quota (invoke_local only)

Rules:
1. Delegate instead of doing it yourself. Multi-file implementation, refactors,
   scaffolding, bulk edits, whole-codebase reading, test writing, and research
   sweeps go through delegate_task / delegate_parallel. Prefer external CLIs over
   in-host subagents for work an external CLI can do.
2. Prefer the external CLIs (${ext1}, ${ext2}). The ${hostAgent} backend spends
   the SAME subscription quota as the parent (${hostLabel}) host, so it offloads
   context but not quota; auto-routing never picks ${hostAgent}. Reach for ${hostAgent}
   only when explicitly asked or when ${ext1} and ${ext2} are both depleted.
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
   across the external CLIs (${ext1}, ${ext2}) with per-task quota failover.
7. Async flow: delegate_task and delegate_parallel default to async=true, returning
   a job_id immediately. Poll get_job_result(job_id, wait_sec=25) until finished.
   invoke_* defaults to async=false for synchronous work; pass async=true for
   longer tasks. get_job_status lists jobs, and cancel_job aborts running tasks.
   Finished jobs are kept for one hour, up to 50; running jobs last until completion.
   同步呼叫可用 async=false；長任務先派工，再輪詢 get_job_result，避免主機逾時。
9. Local backend: Ollama ${DEFAULT_LOCAL_MODEL} on this machine uses zero cloud quota.
   Use invoke_local for bounded tasks: summaries, review, drafting, classification,
   and small file edits. Without work_dir it is text-only, so pass all context
   explicitly. With work_dir it runs a tool loop that can list/read/search files
   and, with sandbox=workspace-write (default), write/edit/delete them. Paths are
   confined to work_dir by the server and there is no shell tool, so it cannot run
   tests. Review its diff (files_changed). Make one call at a time; output is unverified.
   Local is never auto-selected by delegate_task; omit model to prefer its default.
10. Advisor Mode (cross-provider top-tier consultation): when working with a cheaper
    executor model and hitting a hard bug, architectural decision, or design impasse,
    consult a top-tier Advisor model in read-only mode via consult_advisor without
    handing off file edits. Works across Claude, AGY, and Codex hosts (including
    AGY consulting Codex or Claude, and Claude consulting AGY or Codex). Strongest callable defaults:
      - agy    -> ${ADVISOR_MODELS.agy.model} (effort ${ADVISOR_MODELS.agy.effort})
      - codex  -> ${ADVISOR_MODELS.codex.model} (effort ${ADVISOR_MODELS.codex.effort})
      - claude -> ${ADVISOR_MODELS.claude.model} (effort ${ADVISOR_MODELS.claude.effort})
    Use configure_advisor to inspect or pin the session's active advisor provider
    (auto|agy|codex|claude). consult_advisor defaults to async=true; poll get_job_result.${orchestratorRule}`;
}

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
  const hostAgent = getHostAgent();
  const [ext1, ext2] = getExternalAgents(hostAgent);
  const server = new Server(
    {
      name: 'agent-delegation-mcp-server',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: buildDelegationPolicy(hostAgent),
    }
  );

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'invoke_local',
          description: `Run a bounded task with local Ollama (${DEFAULT_LOCAL_MODEL}); zero cloud quota. Without work_dir: text-only, pass all context explicitly. With work_dir: the model gets file tools (list/read/search; plus write/edit/delete under workspace-write) confined to work_dir, no shell; result lists files_changed, review the diff. One call at a time; output is unverified. Defaults synchronous; async=true returns a job_id.`,
          inputSchema: toToolSchema(invokeLocalSchema),
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        {
          name: 'list_local_models',
          description: 'List allowed installed and loaded Ollama models, default model, address and reachability. No cloud calls.',
          inputSchema: toToolSchema(listLocalModelsSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
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
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the Google Antigravity (AGY) CLI subagent. Defaults: ${DEFAULT_MODELS.agy.model}, effort ${DEFAULT_MODELS.agy.effort}, accept-edits mode with permission prompts skipped.${hostAgent === 'agy' ? ` Last resort: it spends the same subscription quota as the parent agent, so prefer ${ext1} / ${ext2}.` : ''}`,
          inputSchema: toToolSchema(invokeAgySchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'invoke_codex',
          description:
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the OpenAI Codex CLI subagent. Defaults: ${DEFAULT_MODELS.codex.model}, effort ${DEFAULT_MODELS.codex.effort}, workspace-write sandbox with approvals auto-handled. Handles non-ASCII Windows paths via junction aliases.${hostAgent === 'codex' ? ` Last resort: it spends the same subscription quota as the parent agent, so prefer ${ext1} / ${ext2}.` : ''}`,
          inputSchema: toToolSchema(invokeCodexSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'invoke_claude',
          description:
            `Defaults to synchronous; set async=true for long work and poll get_job_result. Directly invoke the Anthropic Claude CLI subagent (${DEFAULT_MODELS.claude.model}, effort ${DEFAULT_MODELS.claude.effort}) with token-isolated context (--safe-mode) and session resume.${hostAgent === 'claude' ? ` Last resort: it spends the same subscription quota as the parent agent, so prefer invoke_agy / invoke_codex.` : ''}`,
          inputSchema: toToolSchema(invokeClaudeSchema),
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'consult_advisor',
          description:
            `Advisor Mode (read-only cross-provider consultation). Defaults to async=true: returns job_id; poll get_job_result. Consult the strongest callable model of AGY (${ADVISOR_MODELS.agy.model} ${ADVISOR_MODELS.agy.effort}), Codex (${ADVISOR_MODELS.codex.model} ${ADVISOR_MODELS.codex.effort}), or Claude (${ADVISOR_MODELS.claude.model} ${ADVISOR_MODELS.claude.effort}) when a cheaper executor hits a hard bug, architecture decision, or design tradeoff. Never modifies files.`,
          inputSchema: toToolSchema(consultAdvisorSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'configure_advisor',
          description:
            `View or set the active session Advisor provider/model/effort used by consult_advisor (auto|agy|codex|claude). Call with no arguments to inspect current settings and each provider's strongest default advisor model.`,
          inputSchema: toToolSchema(configureAdvisorSchema),
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
        case 'invoke_local': return await handleInvokeLocal(invokeLocalSchema.parse(args), context);
        case 'list_local_models': {
          listLocalModelsSchema.parse(args);
          return await handleListLocalModels();
        }
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
        case 'consult_advisor': {
          const parsed = consultAdvisorSchema.parse(args);
          return await handleConsultAdvisor(parsed, context);
        }
        case 'configure_advisor': {
          const parsed = configureAdvisorSchema.parse(args);
          return handleConfigureAdvisor(parsed);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
