import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../index.js', import.meta.url));
function json(result: { [key: string]: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content.find(item => item.type === 'text')!.text);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), message);
}
async function fakeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-jobs-'));
  const pidFile = path.join(dir, 'pid.txt');
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_JOB_PID_FILE, String(process.pid));
console.log('FAKE_PROGRESS');
const slow = process.argv.at(-1) === 'slow';
setTimeout(() => { console.log('FAKE_JOB_DONE'); }, slow ? 60000 : 400);
`);
  const executable = path.join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake');
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { CODEX_CLI_PATH: executable, AGENT_DELEGATION_DEPTH: '0', FAKE_JOB_PID_FILE: pidFile });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
  const client = new Client({ name: 'fake-job-tests', version: '1.0' });
  await client.connect(transport);
  return { client, dir, pidFile, async close() {
    await client.close();
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (alive(pid)) { process.kill(pid); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('stdio advertises job schemas and dispatches async invoker/default delegate jobs', async () => {
  const server = await fakeServer();
  try {
    const tools = (await server.client.listTools()).tools;
    for (const name of ['get_job_status', 'get_job_result', 'cancel_job']) assert.ok(tools.some(tool => tool.name === name));
    for (const name of ['get_job_status', 'get_job_result', 'get_agent_quotas']) {
      const tool = tools.find(t => t.name === name);
      assert.equal((tool as any)?.annotations?.readOnlyHint, true);
    }
    for (const name of ['delegate_task', 'delegate_parallel', 'invoke_codex', 'invoke_agy', 'invoke_claude']) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema.properties!.async as { default: boolean };
      assert.equal(schema.default, name.startsWith('delegate_'));
    }
    const pollSchema = tools.find(tool => tool.name === 'get_job_result')!.inputSchema.properties!.wait_sec as { default: number; maximum: number };
    assert.equal(pollSchema.default, 25);
    assert.equal(pollSchema.maximum, 50);
    for (const name of ['invoke_codex', 'delegate_task']) {
      const dispatched = json(await server.client.callTool({ name, arguments: {
        prompt: 'quick', work_dir: server.dir, ...(name === 'invoke_codex' ? { async: true } : { balance_quota: false, agent: 'codex', fallback_agent: 'none' }),
      } }));
      assert.equal(dispatched.status, 'running');
      assert.ok(dispatched.job_id);
      const completed = json(await server.client.callTool({ name: 'get_job_result', arguments: { job_id: dispatched.job_id, wait_sec: 5 } }));
      assert.equal(completed.status, 'succeeded');
      assert.equal(completed.exitCode, 0);
      assert.match(completed.result, /FAKE_JOB_DONE/);
    }
    const statuses = json(await server.client.callTool({ name: 'get_job_status' }));
    assert.equal(statuses.length, 2);
  } finally { await server.close(); }
});

test('stdio synchronous request emits progress and MCP cancellation kills its fake child', async () => {
  const server = await fakeServer();
  try {
    const controller = new AbortController();
    const messages: string[] = [];
    const pending = server.client.callTool({ name: 'invoke_codex', arguments: { prompt: 'slow', work_dir: server.dir } }, undefined, {
      signal: controller.signal,
      onprogress: progress => { messages.push(progress.message ?? ''); },
    });
    // Attach rejection handling before cancelling so no rejection is unhandled.
    const rejected = assert.rejects(pending);
    await until(() => messages.length > 0 && fs.existsSync(server.pidFile), 'Fake stdout must produce MCP progress.');
    assert.match(messages[0], /codex: running for \d+s/);
    const pid = Number(fs.readFileSync(server.pidFile, 'utf8'));
    controller.abort();
    await rejected;
    await until(() => !alive(pid), 'MCP request cancellation must terminate the fake child.');
    assert.ok((await server.client.listTools()).tools.length > 0, 'Server remains available after cancellation.');
  } finally { await server.close(); }
});

test('stdio cancel_job and server stdin closure terminate asynchronous fake children', async () => {
  const server = await fakeServer();
  try {
    const dispatch = () => server.client.callTool({ name: 'invoke_codex', arguments: { prompt: 'slow', work_dir: server.dir, async: true } });
    const first = json(await dispatch());
    await until(() => fs.existsSync(server.pidFile), 'Async child must start.');
    const firstPid = Number(fs.readFileSync(server.pidFile, 'utf8'));
    const cancelled = json(await server.client.callTool({ name: 'cancel_job', arguments: { job_id: first.job_id } }));
    assert.equal(cancelled.status, 'cancelled');
    await until(() => !alive(firstPid), 'cancel_job must terminate its child.');
    fs.unlinkSync(server.pidFile);
    await dispatch();
    await until(() => fs.existsSync(server.pidFile), 'Second async child must start.');
    const secondPid = Number(fs.readFileSync(server.pidFile, 'utf8'));
    await server.client.close();
    await until(() => !alive(secondPid), 'Closing the server stdin must terminate running jobs.');
  } finally { await server.close(); }
});
