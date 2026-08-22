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
    }
  );

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_agent_quotas',
          description:
            'Inspect live real-time subscription quotas, rate limits, and login availability across Antigravity CLI, Codex CLI, and Claude Code without starting a model turn.',
          inputSchema: toToolSchema(getAgentQuotasSchema),
        },
        {
          name: 'delegate_task',
          description:
            'Autonomously delegate a task to the most appropriate external subagent CLI (Antigravity, Codex, or Claude Code) with intelligent quota load-balancing and sandboxing.',
          inputSchema: toToolSchema(delegateTaskSchema),
        },
        {
          name: 'delegate_parallel',
          description:
            'Execute multiple subagent tasks concurrently across CLI workers with a configurable concurrency limit.',
          inputSchema: toToolSchema(delegateParallelSchema),
        },
        {
          name: 'invoke_agy',
          description:
            'Directly invoke Google Antigravity (AGY) CLI subagent with specified mode (plan / accept-edits), Gemini 3.7 model, and thinking effort.',
          inputSchema: toToolSchema(invokeAgySchema),
        },
        {
          name: 'invoke_codex',
          description:
            'Directly invoke OpenAI Codex CLI subagent with specified sandbox permission mode (read-only, workspace-write, danger-full-access).',
          inputSchema: toToolSchema(invokeCodexSchema),
        },
        {
          name: 'invoke_claude',
          description:
            'Directly invoke Anthropic Claude Code CLI subagent with token-isolated context (--safe-mode), resume session support, and permission modes.',
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
