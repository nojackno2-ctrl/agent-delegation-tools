import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invokeAgy } from '../services/invokers/agy-invoker.js';
import { EXIT_CODES } from '../core/types.js';
import { makeFakeAcpCli } from './helpers/fake-acp.js';

describe('AGY ACP Client', () => {
  it('auto-approves session/request_permission when skipPermissions is enabled and cancels when disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-perm-test-'));
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const agy = makeFakeAcpCli(dir, { echoState: true, requestPermission: true });

      const allowRes = await invokeAgy({
        prompt: 'edit file',
        workDir: dir,
        agyPath: agy,
        skipPermissions: true,
      });
      assert.equal(allowRes.exitCode, 0);
      const allowState = JSON.parse(allowRes.stdout);
      assert.deepEqual(allowState.permissionOutcome, { outcome: 'selected', optionId: 'allow-always' });

      const denyRes = await invokeAgy({
        prompt: 'edit file',
        workDir: dir,
        agyPath: agy,
        skipPermissions: false,
      });
      assert.equal(denyRes.exitCode, 0);
      const denyState = JSON.parse(denyRes.stdout);
      assert.deepEqual(denyState.permissionOutcome, { outcome: 'cancelled' });
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends session/cancel on AbortSignal and returns EXIT_CODES.CANCELLED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cancel-test-'));
    const recordFile = path.join(dir, 'state.json');
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const agy = makeFakeAcpCli(dir, { hangOnPrompt: true, recordFile });
      const controller = new AbortController();
      const pollTimer = setInterval(() => {
        if (fs.existsSync(recordFile)) {
          clearInterval(pollTimer);
          controller.abort();
        }
      }, 25);

      const res = await invokeAgy({
        prompt: 'long task',
        workDir: dir,
        agyPath: agy,
        signal: controller.signal,
      });
      clearInterval(pollTimer);

      assert.equal(res.exitCode, EXIT_CODES.CANCELLED);
      assert.equal(res.cancelled, true);
      const state = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      assert.equal(state.cancelled, true);
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends session/cancel on timeout and returns EXIT_CODES.TIMEOUT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-timeout-test-'));
    const recordFile = path.join(dir, 'state.json');
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const agy = makeFakeAcpCli(dir, { hangOnPrompt: true, recordFile });

      const res = await invokeAgy({
        prompt: 'slow task',
        workDir: dir,
        agyPath: agy,
        timeoutSec: 0.3,
      });

      assert.equal(res.exitCode, EXIT_CODES.TIMEOUT);
      assert.equal(res.timedOut, true);
      const state = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      assert.equal(state.cancelled, true);
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps ACP JSON-RPC quota exhaustion errors to EXIT_CODES.QUOTA_EXCEEDED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-quota-test-'));
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const agy = makeFakeAcpCli(dir, {
        rpcError: { code: 429, message: 'RESOURCE_EXHAUSTED: Your AI credits balance is too low' },
      });

      const res = await invokeAgy({
        prompt: 'test',
        workDir: dir,
        agyPath: agy,
      });

      assert.equal(res.exitCode, EXIT_CODES.QUOTA_EXCEEDED);
      assert.match(res.stderr, /quota exhausted/i);
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails if the ACP process exits 0 before session/prompt completes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-early-exit-test-'));
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const script = path.join(dir, 'early-exit.cjs');
      fs.writeFileSync(script, 'process.stdout.write("premature\\n"); process.exit(0);');
      const agy = path.join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
      fs.writeFileSync(
        agy,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { mode: 0o755 }
      );

      const res = await invokeAgy({
        prompt: 'test',
        workDir: dir,
        agyPath: agy,
      });

      assert.equal(res.exitCode, EXIT_CODES.GENERIC_FAILURE);
      assert.match(res.stderr, /exited before prompt completed/i);
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes multi-byte UTF-8 JSON-RPC lines split across stdout chunks without corruption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-utf8-split-test-'));
    const oldDepth = process.env.AGENT_DELEGATION_DEPTH;
    try {
      process.env.AGENT_DELEGATION_DEPTH = '0';
      const script = path.join(dir, 'utf8-split.cjs');
      fs.writeFileSync(
        script,
        [
          "let buf = '';",
          "process.stdin.on('data', (d) => {",
          "  buf += d.toString('utf8');",
          "  const lines = buf.split(/\\r?\\n/);",
          "  buf = lines.pop() || '';",
          "  for (const line of lines) {",
          "    if (!line.trim()) continue;",
          "    const msg = JSON.parse(line);",
          "    if (msg.method === 'initialize') {",
          "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');",
          "    } else if (msg.method === 'session/new') {",
          "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } }) + '\\n');",
          "    } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {",
          "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
          "    } else if (msg.method === 'session/prompt') {",
          "      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '繁體中文測試🚀' } } } }) + '\\n', 'utf8');",
          "      const splitAt = payload.indexOf(Buffer.from('繁', 'utf8')) + 1;",
          "      process.stdout.write(payload.subarray(0, splitAt));",
          "      setTimeout(() => {",
          "        process.stdout.write(payload.subarray(splitAt));",
          "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');",
          "      }, 15);",
          "    }",
          "  }",
          "});",
          "process.stdin.on('end', () => process.exit(0));",
        ].join('\n'),
        'utf8'
      );
      const agy = path.join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
      fs.writeFileSync(
        agy,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { mode: 0o755 }
      );

      const res = await invokeAgy({
        prompt: 'test utf8',
        workDir: dir,
        agyPath: agy,
      });

      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout, '繁體中文測試🚀');
    } finally {
      if (oldDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
      else process.env.AGENT_DELEGATION_DEPTH = oldDepth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
