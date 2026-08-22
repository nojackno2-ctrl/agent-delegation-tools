import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getAgentQuotasSchema } from './tools/quota.js';
import { delegateTaskSchema, delegateParallelSchema } from './tools/delegate.js';
import { invokeAgySchema, invokeCodexSchema, invokeClaudeSchema } from './tools/invokers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of mcp-server is __dirname / .. (when compiled in dist/)
const mcpServerRoot = path.resolve(__dirname, '..');
const serverIndexPath = path.join(mcpServerRoot, 'dist', 'index.js').replace(/\\/g, '/');

const tools = [
  {
    name: 'get_agent_quotas',
    description:
      'Inspect live real-time subscription quotas, rate limits, and login availability across Antigravity CLI, Codex CLI, and Claude Code without starting a model turn. Features built-in 10-second TTL caching for instant sub-millisecond response.',
    schema: getAgentQuotasSchema,
  },
  {
    name: 'delegate_task',
    description:
      'Autonomously delegate a task to the most appropriate external subagent CLI (Antigravity, Codex, or Claude Code) with intelligent quota load-balancing and sandboxing.',
    schema: delegateTaskSchema,
  },
  {
    name: 'delegate_parallel',
    description:
      'Execute multiple subagent tasks concurrently across CLI workers with a configurable concurrency limit.',
    schema: delegateParallelSchema,
  },
  {
    name: 'invoke_agy',
    description:
      'Directly invoke Google Antigravity (AGY) CLI subagent with specified mode (plan / accept-edits), Gemini 3.7 model, and thinking effort.',
    schema: invokeAgySchema,
  },
  {
    name: 'invoke_codex',
    description:
      'Directly invoke OpenAI Codex CLI subagent with specified sandbox permission mode (read-only, workspace-write, danger-full-access).',
    schema: invokeCodexSchema,
  },
  {
    name: 'invoke_claude',
    description:
      'Directly invoke Anthropic Claude Code CLI subagent with token-isolated context (--safe-mode), resume session support, and permission modes.',
    schema: invokeClaudeSchema,
  },
];

function registerAntigravityGlobal(home: string, serverPath: string) {
  const configPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config: any = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      config = { mcpServers: {} };
    }
  }
  config.mcpServers['agent-delegation'] = {
    command: 'node',
    args: [serverPath],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[OK] Antigravity Global MCP: ${configPath}`);
}

function registerAntigravitySchemas(home: string) {
  const mcpDir = path.join(home, '.gemini', 'antigravity', 'mcp', 'agent-delegation');
  fs.mkdirSync(mcpDir, { recursive: true });

  for (const t of tools) {
    const rawSchema = zodToJsonSchema(t.schema, { target: 'openApi3' }) as any;
    const toolJson = {
      name: t.name,
      description: t.description,
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: rawSchema.properties || {},
        required: rawSchema.required || [],
      },
    };
    if (rawSchema.required && rawSchema.required.length === 0) {
      delete (toolJson.parameters as any).required;
    }
    const targetFile = path.join(mcpDir, `${t.name}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(toolJson, null, 2), 'utf8');
  }

  const instructionsPath = path.join(mcpDir, 'instructions.md');
  const instructionsContent = `# Agent Delegation MCP Server

Standard Model Context Protocol (MCP) tool suite for subagent delegation and quota-aware load balancing across Antigravity CLI, Codex CLI, and Claude Code.

## Best Practices & Guidelines

1. **Quota Inspection Before Heavy Tasks**: Call \`get_agent_quotas\` before launching large or batch delegations to verify provider health and remaining quotas.
2. **Intelligent Routing**: Use \`delegate_task\` with \`task_type: "analysis"\` for fast Gemini Flash analysis, \`task_type: "implementation"\` for Codex multi-file changes, and \`task_type: "review"\` for Claude security and logical audits.
3. **Workspace Permissions**: Always specify \`sandbox: "workspace-write"\` when delegating code edits, bug fixes, or file creations.
4. **Concurrency & Parallelism**: Use \`delegate_parallel\` to dispatch multiple independent tasks simultaneously.
`;
  fs.writeFileSync(instructionsPath, instructionsContent, 'utf8');
  console.log(`[OK] Antigravity Tool Schemas: ${mcpDir}`);
}

function registerAntigravityUserSettings(appdata: string, serverPath: string) {
  const settingsPath = path.join(appdata, 'Antigravity', 'User', 'settings.json');
  if (fs.existsSync(path.dirname(settingsPath))) {
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {}
    }
    if (!settings['mcp.servers']) settings['mcp.servers'] = {};
    settings['mcp.servers']['agent-delegation'] = {
      command: 'node',
      args: [serverPath],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
    console.log(`[OK] Antigravity User Settings: ${settingsPath}`);
  }
}

function registerClaudeDesktop(appdata: string, serverPath: string) {
  const configPath = path.join(appdata, 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config: any = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      config = { mcpServers: {} };
    }
  }
  config.mcpServers['agent-delegation'] = {
    command: 'node',
    args: [serverPath],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[OK] Claude Desktop: ${configPath}`);
}

function registerClaudeCli(home: string, serverPath: string) {
  const configPath = path.join(home, '.claude.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers['agent-delegation'] = {
        command: 'node',
        args: [serverPath],
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[OK] Claude Code CLI: ${configPath}`);
    } catch (e: any) {
      console.warn(`[WARN] Failed to update ${configPath}: ${e.message}`);
    }
  }
}

function registerCodex(home: string, serverPath: string) {
  const configPath = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(configPath)) {
    let content = fs.readFileSync(configPath, 'utf8');
    const sectionHeader = '[mcp_servers.agent_delegation]';
    const escapedPath = serverPath.replace(/\\/g, '\\\\');
    const tomlBlock = `[mcp_servers.agent_delegation]\ncommand = "node"\nargs = ["${escapedPath}"]\n`;

    if (content.includes(sectionHeader)) {
      const regex = /\[mcp_servers\.agent_delegation\][\s\S]*?(?=\n\[|\n*$)/;
      content = content.replace(regex, tomlBlock.trimEnd());
    } else {
      content = content.trimEnd() + '\n\n' + tomlBlock;
    }
    fs.writeFileSync(configPath, content, 'utf8');
    console.log(`[OK] Codex CLI: ${configPath}`);
  }
}

export function registerAll() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  console.log('=== Registering Agent Delegation MCP Server ===');
  console.log(`Server Path: ${serverIndexPath}\n`);

  registerAntigravityGlobal(home, serverIndexPath);
  registerAntigravitySchemas(home);
  registerAntigravityUserSettings(appdata, serverIndexPath);
  registerClaudeDesktop(appdata, serverIndexPath);
  registerClaudeCli(home, serverIndexPath);
  registerCodex(home, serverIndexPath);

  console.log('\n=== All AI Client Registrations Complete! ===');
}

// Auto-run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  registerAll();
}
