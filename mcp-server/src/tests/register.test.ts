import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  resolveNodePath,
  updateCodexToml,
  buildCodexTomlSection,
  isDelegationSection,
  isVolatileNodePath,
  findStableNodeOnPath,
} from '../register.js';

describe('Codex MCP Registration & TOML Normalization', () => {
  const sampleNodePath = 'C:\\Program Files\\nodejs\\node.exe';
  const sampleServerPath = 'C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js';

  describe('resolveNodePath', () => {
    it('should fall back to process.execPath when env variable is not set', () => {
      const resolved = resolveNodePath({});
      assert.equal(resolved, process.execPath);
    });

    it('should fall back to process.execPath when CODEX_MCP_NODE_PATH points to non-existent file', () => {
      const resolved = resolveNodePath({
        CODEX_MCP_NODE_PATH: 'C:\\non_existent_path\\node_fake_xyz.exe',
      });
      assert.equal(resolved, process.execPath);
    });

    it('should use CODEX_MCP_NODE_PATH when it points to an existing file', () => {
      // process.execPath is a guaranteed existing file
      const resolved = resolveNodePath({
        CODEX_MCP_NODE_PATH: process.execPath,
      });
      assert.equal(resolved, process.execPath);
    });

    it('should fall back to process.execPath when CODEX_MCP_NODE_PATH points to a directory', () => {
      const tempDir = os.tmpdir();
      const resolved = resolveNodePath({
        CODEX_MCP_NODE_PATH: tempDir,
      });
      assert.equal(resolved, process.execPath);
    });

    it('should prefer a stable node on PATH over process.execPath', () => {
      const stableDir = path.dirname(process.execPath);
      const resolved = resolveNodePath({ PATH: stableDir });
      // dirname(execPath) always contains the running node binary
      assert.equal(resolved, findStableNodeOnPath({ PATH: stableDir }));
      assert.ok(resolved && resolved.length > 0);
    });

    it('should skip volatile Codex runtime dirs when scanning PATH', () => {
      const volatileDir = 'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\abc123\\bin';
      assert.equal(findStableNodeOnPath({ PATH: volatileDir }), null);
    });
  });

  describe('isVolatileNodePath', () => {
    it('flags per-update Codex runtime node paths', () => {
      assert.equal(
        isVolatileNodePath('C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\57937f104cca4dc5\\bin\\node.exe'),
        true
      );
      assert.equal(isVolatileNodePath('C:/Users/x/AppData/Local/OpenAI/Codex/runtimes/cua_node/abc/bin/node.exe'), true);
    });

    it('does not flag durable install locations', () => {
      assert.equal(isVolatileNodePath('C:\\Program Files\\nodejs\\node.exe'), false);
      assert.equal(isVolatileNodePath('C:\\Users\\x\\AppData\\Local\\hermes\\node\\node.exe'), false);
    });
  });

  describe('isDelegationSection', () => {
    it('should recognize canonical and legacy table headers and their subtables', () => {
      assert.equal(isDelegationSection('mcp_servers.agent_delegation'), true);
      assert.equal(isDelegationSection('mcp_servers.agent-delegation'), true);
      assert.equal(isDelegationSection('mcp_servers.agent_delegation.env'), true);
      assert.equal(isDelegationSection('mcp_servers.agent-delegation.env'), true);
      assert.equal(isDelegationSection('mcp_servers."agent_delegation"'), true);
      assert.equal(isDelegationSection('mcp_servers."agent-delegation"'), true);
    });

    it('should not match unrelated sections', () => {
      assert.equal(isDelegationSection('mcp_servers.node_repl'), false);
      assert.equal(isDelegationSection('mcp_servers.davinci-resolve'), false);
      assert.equal(isDelegationSection('desktop'), false);
      assert.equal(isDelegationSection('plugins."chrome@openai-bundled"'), false);
      assert.equal(isDelegationSection(null), false);
    });
  });

  describe('buildCodexTomlSection', () => {
    it('should format valid TOML table with escaped paths', () => {
      const block = buildCodexTomlSection(sampleNodePath, sampleServerPath);
      assert.match(block, /^\[mcp_servers\.agent_delegation\]/);
      assert.match(block, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
      assert.match(block, /args = \["C:\/離線儲存\/程式設計\/子代理\/mcp-server\/dist\/index\.js"\]/);
    });
  });

  describe('updateCodexToml', () => {
    it('should remove legacy [mcp_servers.agent-delegation] and produce single canonical table', () => {
      const legacyToml = `model = "gpt-5.6-luna"

[mcp_servers.agent-delegation]
command = "node"
args = ["legacy/path/index.js"]

[desktop]
localeOverride = "zh-TW"`;

      const result = updateCodexToml(legacyToml, sampleNodePath, sampleServerPath);

      assert.ok(!result.includes('[mcp_servers.agent-delegation]'), 'Must not contain legacy hyphen table');
      assert.ok(result.includes('[mcp_servers.agent_delegation]'), 'Must contain canonical underscore table');
      assert.ok(result.includes('model = "gpt-5.6-luna"'), 'Must preserve top-level config');
      assert.ok(result.includes('[desktop]'), 'Must preserve unrelated tables');
      assert.ok(result.includes('localeOverride = "zh-TW"'), 'Must preserve desktop config');
    });

    it('should normalize duplicate canonical sections into exactly one table', () => {
      const duplicateToml = `[mcp_servers.agent_delegation]
command = "old-node"
args = ["old-server.js"]

[mcp_servers.other]
command = "other.exe"

[mcp_servers.agent_delegation]
command = "duplicate-node"
args = ["duplicate-server.js"]`;

      const result = updateCodexToml(duplicateToml, sampleNodePath, sampleServerPath);

      const occurrences = (result.match(/\[mcp_servers\.agent_delegation\]/g) || []).length;
      assert.equal(occurrences, 1, 'Should have exactly one canonical table');
      assert.ok(result.includes('[mcp_servers.other]'), 'Must preserve unrelated server');
      assert.ok(!result.includes('duplicate-node'), 'Duplicate section must be eliminated');
    });

    it('should clean up both canonical and legacy duplicate sections when both coexist', () => {
      const mixedToml = `[mcp_servers.agent_delegation]
command = "node"
args = ["old-path.js"]

[mcp_servers.davinci-resolve]
command = 'C:\\python.exe'
args = ['C:\\server.py']

[mcp_servers.davinci-resolve.env]
KEY = "VALUE"

[mcp_servers.agent-delegation]
command = "node"
args = ["old-path.js"]

[desktop]
localeOverride = "zh-TW"`;

      const result = updateCodexToml(mixedToml, sampleNodePath, sampleServerPath);

      const canonicalMatches = result.match(/\[mcp_servers\.agent_delegation\]/g) || [];
      assert.equal(canonicalMatches.length, 1, 'Exactly one canonical table must remain');
      assert.ok(!result.includes('[mcp_servers.agent-delegation]'), 'Legacy table must be removed');
      assert.ok(result.includes('[mcp_servers.davinci-resolve]'), 'Unrelated table must remain');
      assert.ok(result.includes('[mcp_servers.davinci-resolve.env]'), 'Unrelated subtable must remain');
      assert.ok(result.includes('KEY = "VALUE"'), 'Subtable values must remain');
      assert.ok(result.includes('[desktop]'), 'Desktop section must remain');
    });

    it('should preserve unrelated TOML structures and comments', () => {
      const complexToml = `# Top-level comment
model = "gpt-5.6-luna"
model_reasoning_effort = "high"
approval_policy = "never"

[marketplaces.openai-bundled]
source_type = "local"
source = '\\\\?\\C:\\Users\\test\\.codex'

[plugins."chrome@openai-bundled"]
enabled = true

[features]
js_repl = false
memories = true

[mcp_servers.node_repl]
args = []
command = 'C:\\node_repl.exe'

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\test\\.codex'

[desktop]
conversationDetailMode = "STEPS_COMMANDS"`;

      const result = updateCodexToml(complexToml, sampleNodePath, sampleServerPath);

      assert.ok(result.includes('# Top-level comment'));
      assert.ok(result.includes('model = "gpt-5.6-luna"'));
      assert.ok(result.includes('[marketplaces.openai-bundled]'));
      assert.ok(result.includes('[plugins."chrome@openai-bundled"]'));
      assert.ok(result.includes('[features]'));
      assert.ok(result.includes('[mcp_servers.node_repl]'));
      assert.ok(result.includes('[mcp_servers.node_repl.env]'));
      assert.ok(result.includes('[mcp_servers.agent_delegation]'));
      assert.ok(result.includes('[desktop]'));
    });

    it('should be idempotent across successive runs', () => {
      const initialToml = `model = "gpt-5.6-luna"

[mcp_servers.agent-delegation]
command = "node"
args = ["legacy.js"]

[desktop]
locale = "en"`;

      const run1 = updateCodexToml(initialToml, sampleNodePath, sampleServerPath);
      const run2 = updateCodexToml(run1, sampleNodePath, sampleServerPath);
      const run3 = updateCodexToml(run2, sampleNodePath, sampleServerPath);

      assert.equal(run2, run1, 'Second run must equal first run');
      assert.equal(run3, run2, 'Third run must equal second run');
    });

    it('should correctly escape Windows backslashes and unicode paths', () => {
      const windowsNode = 'C:\\Program Files (x86)\\Node.js\\node.exe';
      const unicodeServer = 'C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js';

      const result = updateCodexToml('', windowsNode, unicodeServer);

      assert.ok(result.includes('command = "C:\\\\Program Files (x86)\\\\Node.js\\\\node.exe"'));
      assert.ok(result.includes('args = ["C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js"]'));
    });
  });
});
