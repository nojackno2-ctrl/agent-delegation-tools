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

/**
 * Sent to the host agent on connect. This is the contract that makes the parent
 * a dispatcher rather than a worker.
 */
const DELEGATION_POLICY = `Delegation-first policy for this workspace.

The parent agent is a dispatcher. Real work belongs to the three subscription
CLIs behind these tools, and the two external ones carry the load:

  - agy    -> Google Antigravity, gemini-3.7-flash, effort high (default)
  - codex  -> OpenAI Codex CLI, gpt-5.6-luna, effort high (default)
  - claude -> Claude CLI, claude-sonnet-5, effort high (default)

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
   across the external CLIs.`;

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
            'Read live subscription quotas, rate-limit windows, and login state for all three CLIs (Antigravity, Codex, Claude) without starting a model turn. 10-second cache.',
          inputSchema: toToolSchema(getAgentQuotasSchema),
        },
        {
          name: 'delegate_task',
          description:
            'PREFERRED way to get work done: hand a task to an external subagent CLI instead of doing it in the parent agent. Auto-routes by task type and live quota (agy = Gemini 3.7 Flash high, codex = GPT-5.6-Luna high), fails over when a provider is depleted, and runs write-capable by default so the subagent edits files under work_dir without any approval prompt.',
          inputSchema: toToolSchema(delegateTaskSchema),
        },
        {
          name: 'delegate_parallel',
          description:
            'Run a batch of independent tasks concurrently, spread round-robin across the external CLIs with quota-aware failover. Use for multi-component builds, per-file refactors, and fan-out research.',
          inputSchema: toToolSchema(delegateParallelSchema),
        },
        {
          name: 'invoke_agy',
          description:
            'Directly invoke the Google Antigravity (AGY) CLI subagent. Defaults: gemini-3.7-flash, effort high, accept-edits mode with permission prompts skipped.',
          inputSchema: toToolSchema(invokeAgySchema),
        },
        {
          name: 'invoke_codex',
          description:
            'Directly invoke the OpenAI Codex CLI subagent. Defaults: gpt-5.6-luna, effort high, workspace-write sandbox with approvals auto-handled. Handles non-ASCII Windows paths via junction aliases.',
          inputSchema: toToolSchema(invokeCodexSchema),
        },
        {
          name: 'invoke_claude',
          description:
            'Directly invoke the Anthropic Claude CLI subagent (claude-sonnet-5, effort high) with token-isolated context (--safe-mode) and session resume. Last resort: it spends the same subscription quota as the parent agent, so prefer invoke_agy / invoke_codex.',
          inputSchema: toToolSchema(invokeClaudeSchema),
        },
      ],
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'get_agent_quotas': {
          const parsed = getAgentQuotasSchema.parse(args);
          return await handleGetAgentQuotas(parsed);
        }
        case 'delegate_task': {
          const parsed = delegateTaskSchema.parse(args);
          return await handleDelegateTask(parsed);
        }
        case 'delegate_parallel': {
          const parsed = delegateParallelSchema.parse(args);
          return await handleDelegateParallel(parsed);
        }
        case 'invoke_agy': {
          const parsed = invokeAgySchema.parse(args);
          return await handleInvokeAgy(parsed);
        }
        case 'invoke_codex': {
          const parsed = invokeCodexSchema.parse(args);
          return await handleInvokeCodex(parsed);
        }
        case 'invoke_claude': {
          const parsed = invokeClaudeSchema.parse(args);
          return await handleInvokeClaude(parsed);
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
