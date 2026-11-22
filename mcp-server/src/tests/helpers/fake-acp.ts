import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeAcpOptions {
  name?: string;
  output?: string;
  echoState?: boolean;
  stderr?: string;
  exitCode?: number;
  rpcError?: { code: number; message: string };
  hangOnPrompt?: boolean;
  requestPermission?: boolean;
  recordFile?: string;
}

export function makeFakeAcpCli(dir: string, options: FakeAcpOptions = {}): string {
  const name = options.name || 'agy';
  const script = path.join(dir, `${name}-acp.cjs`);
  const config = JSON.stringify({
    output: options.output ?? 'ACP_FAKE_OK',
    echoState: Boolean(options.echoState),
    stderr: options.stderr ?? '',
    exitCode: options.exitCode ?? 0,
    rpcError: options.rpcError ?? null,
    hangOnPrompt: Boolean(options.hangOnPrompt),
    requestPermission: Boolean(options.requestPermission),
    recordFile: options.recordFile ?? null,
  });

  fs.writeFileSync(
    script,
    `
const fs = require('node:fs');
const cfg = ${config};
const state = {
  argv: process.argv.slice(2),
  modelId: null,
  modeId: null,
  prompt: null,
  cancelled: false,
  permissionOutcome: null,
};
const saveState = () => {
  if (cfg.recordFile) {
    fs.writeFileSync(cfg.recordFile, JSON.stringify(state, null, 2));
  }
};
const send = (obj) => {
  process.stdout.write(JSON.stringify(obj) + '\\n');
};

if (cfg.exitCode !== 0 && !cfg.rpcError) {
  if (cfg.stderr) process.stderr.write(cfg.stderr + '\\n');
  process.exit(cfg.exitCode);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '1.0.0' } } });
    } else if (msg.method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'fake-session-1',
          models: {
            availableModels: [
              { modelId: 'gemini-4-hydrogen-low' },
              { modelId: 'gemini-4-hydrogen-xhigh' },
              { modelId: 'gemini-4-neon-low' },
              { modelId: 'gemini-4-neon-xhigh' },
              { modelId: 'gemini-4-argon-low' },
              { modelId: 'gemini-4-argon-high' },
              { modelId: 'gemini-3.8-flash-medium' },
              { modelId: 'gemini-pro-orchestrator-g1-pro' },
              { modelId: 'gemini-pro-orchestrator-neon' },
              { modelId: 'gpt-oss-120b-medium' },
            ],
            currentModelId: 'gemini-4-hydrogen-low',
          },
          modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept-edits' }, { id: 'plan' }] },
        },
      });
    } else if (msg.method === 'session/set_model') {
      state.modelId = msg.params && msg.params.modelId;
      saveState();
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/set_mode') {
      state.modeId = msg.params && msg.params.modeId;
      saveState();
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/prompt') {
      state.prompt = msg.params && msg.params.prompt;
      saveState();
      if (cfg.rpcError) {
        send({ jsonrpc: '2.0', id: msg.id, error: cfg.rpcError });
        continue;
      }
      if (cfg.requestPermission) {
        send({
          jsonrpc: '2.0',
          id: 9001,
          method: 'session/request_permission',
          params: {
            sessionId: 'fake-session-1',
            options: [
              { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
            ],
          },
        });
        continue;
      }
      if (cfg.hangOnPrompt) {
        continue;
      }
      const text = cfg.echoState ? JSON.stringify(state) : cfg.output;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fake-session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (msg.id === 9001 && msg.result) {
      state.permissionOutcome = msg.result.outcome;
      saveState();
      const text = cfg.echoState ? JSON.stringify(state) : cfg.output;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fake-session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      send({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } });
    } else if (msg.method === 'session/cancel') {
      state.cancelled = true;
      saveState();
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(cfg.exitCode));
`
  );

  const executable = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(
    executable,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 }
  );
  return executable;
}
