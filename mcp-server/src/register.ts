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
export const mcpServerRoot = path.resolve(__dirname, '..');
export const serverIndexPath = path.join(mcpServerRoot, 'dist', 'index.js').replace(/\\/g, '/');

export const tools = [
  {
    name: 'get_agent_quotas',
    description:
      'Inspect live 7-day subscription quotas, shorter rate-limit windows, and login availability across Antigravity CLI, Codex CLI, and Claude Code without starting a model turn. AGY uses the official /usage slash command. Features built-in 10-second TTL caching.',
    schema: getAgentQuotasSchema,
  },
  {
    name: 'delegate_task',
    description:
      'PREFERRED way to get work done: hand a task to an external subagent CLI instead of doing it in the parent agent. Auto-routes by task type and live quota (agy = Gemini 3.7 Flash high, codex = GPT-5.6-Luna high), fails over when a provider is depleted, and runs write-capable by default so the subagent edits files under work_dir without any approval prompt.',
    schema: delegateTaskSchema,
  },
  {
    name: 'delegate_parallel',
    description:
      'Run a batch of independent tasks concurrently, spread round-robin across the external CLIs with quota-aware failover. Use for multi-component builds, per-file refactors, and fan-out research.',
    schema: delegateParallelSchema,
  },
  {
    name: 'invoke_agy',
    description:
      'Directly invoke the Google Antigravity (AGY) CLI subagent. Defaults: gemini-3.7-flash, effort high, accept-edits mode with permission prompts skipped.',
    schema: invokeAgySchema,
  },
  {
    name: 'invoke_codex',
    description:
      'Directly invoke the OpenAI Codex CLI subagent. Defaults: gpt-5.6-luna, effort high, workspace-write sandbox with approvals auto-handled. Handles non-ASCII Windows paths via junction aliases.',
    schema: invokeCodexSchema,
  },
  {
    name: 'invoke_claude',
    description:
      'Directly invoke the Anthropic Claude CLI subagent (claude-sonnet-5, effort high) with token-isolated context (--safe-mode) and session resume. Last resort: it spends the same subscription quota as the parent agent, so prefer invoke_agy / invoke_codex.',
    schema: invokeClaudeSchema,
  },
];

// Node executables shipped inside these directories are replaced on every Codex
// update (the folder name is a per-build hash), so baking one into config.toml
// leaves a dangling `command` the next time Codex updates.
const VOLATILE_NODE_MARKERS = [path.join('OpenAI', 'Codex', 'runtimes'), 'cua_node', path.join('hermes', 'tmp')];

export function isVolatileNodePath(candidate: string): boolean {
  const normalized = candidate.replace(/\//g, '\\').toLowerCase();
  return VOLATILE_NODE_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
}

// Look for a durable `node` on PATH, skipping the volatile Codex runtime dirs.
export function findStableNodeOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawPath = env.PATH || (env as Record<string, string | undefined>).Path || '';
  if (!rawPath) return null;
  const exts = process.platform === 'win32' ? ['.exe', '', '.cmd'] : [''];
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir || isVolatileNodePath(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `node${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore unreadable PATH entry
      }
    }
  }
  return null;
}

export function resolveNodePath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CODEX_MCP_NODE_PATH;
  if (custom && custom.trim().length > 0) {
    const trimmed = custom.trim();
    try {
      if (fs.existsSync(trimmed)) {
        const stat = fs.statSync(trimmed);
        if (stat.isFile()) {
          return trimmed;
        }
      }
    } catch {
      // Fall through to the PATH scan / process.execPath
    }
  }

  // Prefer a stable node on PATH over process.execPath, which — when this script
  // is run by Codex's bundled node — points at a per-update runtime folder.
  const stable = findStableNodeOnPath(env);
  if (stable) return stable;

  if (isVolatileNodePath(process.execPath)) {
    console.warn(
      `[WARN] Falling back to a volatile Node path (${process.execPath}). ` +
        'Set CODEX_MCP_NODE_PATH to a durable node.exe and re-run register, or the MCP server will break on the next Codex update.'
    );
  }
  return process.execPath;
}

export interface TomlSection {
  header: string | null;
  rawTableName: string | null;
  lines: string[];
}

export function splitTomlSections(content: string): TomlSection[] {
  const lines = content.split(/\r?\n/);
  const sections: TomlSection[] = [];
  let currentSection: TomlSection = {
    header: null,
    rawTableName: null,
    lines: [],
  };

  const headerRegex = /^\s*\[(\[?)([^[\]]+)(\]?)\s*\]\s*(?:#.*)?$/;

  for (const line of lines) {
    const match = line.match(headerRegex);
    if (match) {
      if (currentSection.header !== null || currentSection.lines.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        header: line,
        rawTableName: match[2].trim(),
        lines: [line],
      };
    } else {
      currentSection.lines.push(line);
    }
  }

  if (currentSection.header !== null || currentSection.lines.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

export function isDelegationSection(rawName: string | null): boolean {
  if (!rawName) return false;
  const unquoted = rawName.replace(/"/g, '').trim();
  return (
    unquoted === 'mcp_servers.agent_delegation' ||
    unquoted.startsWith('mcp_servers.agent_delegation.') ||
    unquoted === 'mcp_servers.agent-delegation' ||
    unquoted.startsWith('mcp_servers.agent-delegation.')
  );
}

export function buildCodexTomlSection(nodePath: string, serverPath: string): string {
  const nodeToml = JSON.stringify(nodePath);
  const serverToml = JSON.stringify(serverPath);
  return `[mcp_servers.agent_delegation]\ncommand = ${nodeToml}\nargs = [${serverToml}]`;
}

export function updateCodexToml(
  content: string,
  nodePath: string,
  serverPath: string
): string {
  const sections = splitTomlSections(content);
  const delegationBlock = buildCodexTomlSection(nodePath, serverPath);

  let placed = false;
  const resultSections: string[] = [];

  for (const section of sections) {
    if (isDelegationSection(section.rawTableName)) {
      if (!placed) {
        resultSections.push(delegationBlock);
        placed = true;
      }
      continue;
    }

    const text = section.lines.join('\n').trim();
    if (text.length > 0) {
      resultSections.push(text);
    }
  }

  if (!placed) {
    resultSections.push(delegationBlock);
  }

  return resultSections.join('\n\n') + '\n';
}

export function registerAntigravityGlobal(home: string, serverPath: string, nodePath: string = resolveNodePath()) {
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
    command: nodePath,
    args: [serverPath],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[OK] Antigravity Global MCP: ${configPath}`);
}

export function registerAntigravitySchemas(home: string) {
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

export function registerAntigravityUserSettings(appdata: string, serverPath: string, nodePath: string = resolveNodePath()) {
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
      command: nodePath,
      args: [serverPath],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
    console.log(`[OK] Antigravity User Settings: ${settingsPath}`);
  }
}

export function registerClaudeDesktop(appdata: string, serverPath: string, nodePath: string = resolveNodePath()) {
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
    command: nodePath,
    args: [serverPath],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[OK] Claude Desktop: ${configPath}`);
}

export function registerClaudeCli(home: string, serverPath: string, nodePath: string = resolveNodePath()) {
  const configPath = path.join(home, '.claude.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers['agent-delegation'] = {
        command: nodePath,
        args: [serverPath],
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[OK] Claude Code CLI: ${configPath}`);
    } catch (e: any) {
      console.warn(`[WARN] Failed to update ${configPath}: ${e.message}`);
    }
  }
}

export function registerCodex(home: string, serverPath: string, nodePath: string = resolveNodePath()) {
  const configPath = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(configPath)) {
    const original = fs.readFileSync(configPath, 'utf8');
    const updated = updateCodexToml(original, nodePath, serverPath);
    if (updated !== original) {
      fs.writeFileSync(configPath, updated, 'utf8');
    }
    console.log(`[OK] Codex CLI: ${configPath}`);
  }
}

export function registerAll(nodePath: string = resolveNodePath()) {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  console.log('=== Registering Agent Delegation MCP Server ===');
  console.log(`Node Path:   ${nodePath}`);
  console.log(`Server Path: ${serverIndexPath}\n`);

  registerAntigravityGlobal(home, serverIndexPath, nodePath);
  registerAntigravitySchemas(home);
  registerAntigravityUserSettings(appdata, serverIndexPath, nodePath);
  registerClaudeDesktop(appdata, serverIndexPath, nodePath);
  registerClaudeCli(home, serverIndexPath, nodePath);
  registerCodex(home, serverIndexPath, nodePath);

  console.log('\n=== All AI Client Registrations Complete! ===');
}

// Auto-run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  registerAll();
}
