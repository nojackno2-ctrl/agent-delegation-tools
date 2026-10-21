import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_LOCAL_MODEL, EXTERNAL_AGENTS } from '../core/defaults.js';
import { invokeLocal, listLocalModels } from '../services/invokers/local-invoker.js';
import { handleInvokeLocal, handleListLocalModels, invokeLocalSchema } from '../tools/local.js';
import { jobRegistry } from '../services/jobs/job-registry.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../services/invokers/local-tools.js';

const reply = { message: { content: '本機回答😀' }, done_reason: 'stop', prompt_eval_count: 12, eval_count: 8 };
function fakeFetch(chat: unknown = reply, models = [DEFAULT_LOCAL_MODEL]): typeof fetch {
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    return Response.json(String(url).endsWith('/api/chat') ? chat : { models: models.map(name => ({ name })) });
  };
}

test('local HTTP client sends exact prompts/options and returns structured unverified output', async () => {
  let payload: any;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/api/chat') payload = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/chat' ? reply : { models: [{ name: DEFAULT_LOCAL_MODEL }, { name: 'hidden' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `127.0.0.1:${port}/`;
  try {
    const listed = await listLocalModels({ baseUrl });
    assert.deepEqual(listed.models, [DEFAULT_LOCAL_MODEL]);
    assert.deepEqual(listed.loaded, [DEFAULT_LOCAL_MODEL]);
    assert.equal(listed.reachable, true);
    assert.equal(listed.base_url, `http://127.0.0.1:${port}`);
    const result = await invokeLocal({ baseUrl, task: 'Review', context: 'code', maxTokens: 64 });
    assert.deepEqual(paths, ['/api/tags', '/api/ps', '/api/tags', '/api/chat']);
    assert.deepEqual(payload, {
      model: DEFAULT_LOCAL_MODEL, stream: false, keep_alive: '15m', think: true,
      messages: [
        { role: 'system', content: 'You are a local task delegate. Complete the supplied task concisely. You have no tools, filesystem or internet access. Never claim to have run tests or changed files. Mark uncertainties. Match the task\'s language. Whenever you write Chinese, use Traditional Chinese as used in Taiwan (zh-TW), never Simplified Chinese, and do not add pinyin.' },
        { role: 'user', content: 'Task:\nReview\n\nContext supplied by caller:\ncode' },
      ],
      options: { temperature: 0.2, num_predict: 64 + 8192, num_ctx: 65536 },
    });
    assert.equal(result.answer, reply.message.content);
    assert.equal(result.truncated, false);
    assert.equal(result.thinking, true);
    assert.equal(result.done_reason, 'stop');
    assert.equal(result.prompt_tokens, 12);
    assert.equal(result.generated_tokens, 8);
    assert.equal(result.inference, 'local_ollama');
    assert.equal(result.verified, false);
    assert.ok(result.elapsed_seconds >= 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('missing/disallowed models reject before generation and do not poison the queue', async () => {
  await assert.rejects(invokeLocal({ task: 'x', fetch: fakeFetch(reply, []) }), /not installed/);
  await assert.rejects(invokeLocal({ task: 'x', model: 'unauthorized', fetch: fakeFetch() }), /not allowed/);
  assert.equal((await invokeLocal({ task: 'x', fetch: fakeFetch() })).answer, reply.message.content);
});

test('truncation counts Unicode characters like Python', async () => {
  const result = await invokeLocal({ task: 'x', maxOutputChars: 5, fetch: fakeFetch() });
  assert.equal(result.answer, '本機回答😀');
  assert.equal(result.truncated, false);
  const short = await invokeLocal({ task: 'x', maxOutputChars: 4, fetch: fakeFetch() });
  assert.equal(short.answer, '本機回答');
  assert.equal(short.truncated, true);
});

test('think=false removes reasoning budget; unsupported models omit think', async () => {
  const original = process.env.LOCAL_AI_MODELS;
  process.env.LOCAL_AI_MODELS = 'other, extra';
  try {
    for (const model of [DEFAULT_LOCAL_MODEL, 'other']) {
      const client: typeof fetch = async (url, init) => {
        if (String(url).endsWith('/api/chat')) {
          const payload = JSON.parse(init!.body as string);
          assert.equal(payload.options.num_predict, 32);
          if (model === 'other') assert.equal('think' in payload, false);
          else assert.equal(payload.think, false);
        }
        return fakeFetch(reply, [model])(url, init);
      };
      const result = await invokeLocal({ task: 'x', model, think: model !== DEFAULT_LOCAL_MODEL, maxTokens: 32, fetch: client });
      assert.equal(result.thinking, false);
    }
  } finally {
    if (original === undefined) delete process.env.LOCAL_AI_MODELS;
    else process.env.LOCAL_AI_MODELS = original;
  }
});

test('empty answers and exhausted thinking produce actionable errors', async () => {
  await assert.rejects(invokeLocal({ task: 'x', fetch: fakeFetch({ message: { content: '' }, done_reason: 'length' }) }),
    { message: 'Reasoning used the whole token budget; retry with think=false or a smaller task.' });
  await assert.rejects(invokeLocal({ task: 'x', think: false, fetch: fakeFetch({}) }), /Ollama returned no answer/);
});

test('unreachable model listing is JSON with reachable=false; generation errors name address', async t => {
  const fetch: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const result = await listLocalModels({ baseUrl: 'host:11434', fetch });
  assert.equal(result.reachable, false);
  assert.deepEqual(result.models, []);
  assert.ok('message' in result);
  assert.match(result.message, /http:\/\/host:11434/);
  await assert.rejects(invokeLocal({ task: 'x', baseUrl: 'host:11434', fetch }), /Ollama.*http:\/\/host:11434/);
  t.mock.method(globalThis, 'fetch', fetch);
  const response = await handleListLocalModels();
  assert.equal(JSON.parse(response.content[0].text).reachable, false);
  assert.equal(response.isError, undefined);
});

test('two concurrent generations serialize, including model checks', async () => {
  const events: string[] = [];
  let active = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/chat')) {
      events.push('start');
      assert.equal(++active, 1);
      await delay(30);
      active--;
      events.push('end');
    } else assert.equal(active, 0);
    return fakeFetch()(url, init);
  };
  await Promise.all([invokeLocal({ task: 'one', fetch }), invokeLocal({ task: 'two', fetch })]);
  assert.deepEqual(events, ['start', 'end', 'start', 'end']);
});

test('abort cancels active HTTP fetch and queue recovers', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/api/chat')) return fakeFetch()(url, init);
    entered();
    await delay(10000, undefined, { signal: init!.signal! });
    return Response.json(reply);
  };
  const pending = invokeLocal({ task: 'x', signal: controller.signal, fetch });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  assert.equal((await invokeLocal({ task: 'next', fetch: fakeFetch() })).verified, false);
  await assert.rejects(invokeLocal({ task: 'x', signal: controller.signal, fetch }), { name: 'AbortError' });
});

test('queued cancellation/timeout returns promptly without starting another request', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const slow: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/api/chat')) { entered(); await hold; }
    return fakeFetch()(url, init);
  };
  const first = invokeLocal({ task: 'hold', fetch: slow });
  await enteredPromise;
  try {
    const controller = new AbortController();
    const neverFetch: typeof fetch = async () => { assert.fail('Queued cancelled work must not fetch'); };
    const queued = invokeLocal({ task: 'cancel', fetch: neverFetch, signal: controller.signal });
    const rejected = assert.rejects(queued, { name: 'AbortError' });
    controller.abort();
    await rejected;
    await assert.rejects(invokeLocal({ task: 'timeout', fetch: neverFetch, timeoutSec: 0.02 }), { name: 'TimeoutError' });
  } finally { release(); await first; }
  await invokeLocal({ task: 'next', fetch: fakeFetch() });
});

test('schemas enforce limits and keep local out of automatic routing', () => {
  assert.deepEqual(invokeLocalSchema.parse({ task: 'x' }), {
    task: 'x', async: false, context: '', model: DEFAULT_LOCAL_MODEL, max_tokens: 1024,
    max_output_chars: 6000, think: true, sandbox: 'workspace-write', max_steps: 30,
  });
  for (const override of [{ task: '' }, { task: '  ' }, { task: 'x'.repeat(8001) }, { context: 'x'.repeat(64001) },
    { max_tokens: 31 }, { max_tokens: 4097 }, { max_tokens: 32.5 }, { max_output_chars: 127 }, { max_output_chars: 16001 },
    { timeout_sec: -1 }, { timeout_sec: 3601 }, { work_dir: 'relative/dir' }, { sandbox: 'danger-full-access' },
    { max_steps: 0 }, { max_steps: 101 }]) {
    assert.equal(invokeLocalSchema.safeParse({ task: 'x', ...override }).success, false);
  }
  assert.equal((EXTERNAL_AGENTS as string[]).includes('local'), false);
});

test('handlers report local exit code and async results through the existing job registry', async t => {
  t.mock.method(globalThis, 'fetch', fakeFetch());
  const results: unknown[] = [];
  const sync = await handleInvokeLocal({ task: 'x' }, { onResult: result => results.push(result) });
  assert.equal(JSON.parse(sync.content[0].text).inference, 'local_ollama');
  assert.deepEqual(results, [{ usedAgent: 'local', exitCode: 0 }]);
  const dispatch = await handleInvokeLocal({ task: 'x', async: true });
  const { job_id } = JSON.parse(dispatch.content[0].text);
  const finished = await jobRegistry.wait(job_id, 1);
  assert.equal(finished?.status, 'succeeded');
  assert.deepEqual(finished?.usedAgents, ['local']);
  assert.equal(JSON.parse(finished!.result!).verified, false);
  const controller = new AbortController();
  controller.abort();
  const cancelledResults: unknown[] = [];
  const failure = await handleInvokeLocal({ task: 'x' }, { signal: controller.signal, onResult: result => cancelledResults.push(result) });
  assert.equal(failure.isError, true);
  assert.deepEqual(cancelledResults.at(-1), { usedAgent: 'local', exitCode: 130 });
});

test('stdio local tools honor environment overrides, return async results, and cancel HTTP generation', async () => {
  let started!: () => void;
  const generating = new Promise<void>(resolve => { started = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/chat') {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (payload.messages[1].content.startsWith('Task:\nslow\n')) {
        res.on('close', closed);
        started();
        return;
      }
      assert.equal(payload.model, 'custom-local');
      assert.equal('think' in payload, false);
      assert.equal(payload.options.num_predict, 1024);
      res.end(JSON.stringify(reply));
    } else res.end(JSON.stringify({ models: [{ name: 'custom-local' }, { name: 'extra-local' }, { name: 'hidden' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { OLLAMA_HOST: `127.0.0.1:${port}`, LOCAL_AI_MODEL: 'custom-local', LOCAL_AI_MODELS: ' extra-local, ' });
  const client = new Client({ name: 'local-tests', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' });
  const json = (response: any) => JSON.parse(response.content[0].text);
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal((tools.find(t => t.name === 'invoke_local')!.inputSchema.properties!.model as { default: string }).default, 'custom-local');
    const listed = json(await client.callTool({ name: 'list_local_models', arguments: {} }));
    assert.deepEqual(listed.models, ['custom-local', 'extra-local']);
    assert.deepEqual(listed.loaded, ['custom-local', 'extra-local']);
    assert.equal(listed.default, 'custom-local');
    assert.equal(listed.reachable, true);
    const dispatched = json(await client.callTool({ name: 'invoke_local', arguments: { task: 'quick', async: true } }));
    const finished = json(await client.callTool({ name: 'get_job_result', arguments: { job_id: dispatched.job_id, wait_sec: 5 } }));
    assert.equal(finished.status, 'succeeded');
    assert.deepEqual(finished.usedAgents, ['local']);
    assert.equal(JSON.parse(finished.result).model, 'custom-local');
    assert.equal(JSON.parse(finished.result).verified, false);
    const slow = json(await client.callTool({ name: 'invoke_local', arguments: { task: 'slow', async: true } }));
    await generating;
    const cancelled = json(await client.callTool({ name: 'cancel_job', arguments: { job_id: slow.job_id } }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.exitCode, 130);
    await disconnected;
    const next = json(await client.callTool({ name: 'invoke_local', arguments: { task: 'quick' } }));
    assert.equal(next.answer, reply.message.content);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

/** Scripted Ollama: each /api/chat call returns the next message and records the payload. */
function scripted(turns: unknown[], payloads: any[] = []): typeof fetch {
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    if (!String(url).endsWith('/api/chat')) return Response.json({ models: [{ name: DEFAULT_LOCAL_MODEL }] });
    payloads.push(JSON.parse(init!.body as string));
    const message = turns[Math.min(payloads.length - 1, turns.length - 1)];
    return Response.json({ message, done_reason: 'stop', prompt_eval_count: 1, eval_count: 2 });
  };
}
const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });

async function tempWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-agent-'));
  await writeFile(path.join(dir, 'a.txt'), 'hello world\n');
  return dir;
}

test('agent loop reads then edits a file and reports files_changed', async () => {
  const dir = await tempWorkspace();
  const payloads: any[] = [];
  try {
    const result = await invokeLocal({ task: 'Change world to 世界', workDir: dir, fetch: scripted([
      { content: '', tool_calls: [call('read_file', { path: 'a.txt' })] },
      { content: '', tool_calls: [call('edit_file', JSON.stringify({ path: 'a.txt', old_string: 'world', new_string: '世界' })), call('write_file', { path: 'sub/new.md', content: 'x' })] },
      { content: '已修改 a.txt' },
    ], payloads) });
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'hello 世界\n');
    assert.equal(await readFile(path.join(dir, 'sub', 'new.md'), 'utf8'), 'x');
    assert.equal(result.answer, '已修改 a.txt');
    assert.equal(result.steps, 3);
    assert.equal(result.tool_calls, 3);
    assert.deepEqual(result.files_changed, ['a.txt', 'sub/new.md']);
    assert.equal(result.sandbox, 'workspace-write');
    assert.equal(result.prompt_tokens, 3);
    assert.equal(result.verified, false);
    assert.deepEqual(payloads[0].tools.map((t: any) => t.function.name), ['list_dir', 'read_file', 'search', 'write_file', 'edit_file', 'delete_file']);
    assert.match(payloads[0].messages[0].content, /local coding agent/);
    assert.deepEqual(payloads[1].messages.slice(2), [
      { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'a.txt' })] },
      { role: 'tool', tool_name: 'read_file', content: '1\thello world\n2\t\n' },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only sandbox hides and refuses write tools', async () => {
  const dir = await tempWorkspace();
  const payloads: any[] = [];
  try {
    const result = await invokeLocal({ task: 'x', workDir: dir, sandbox: 'read-only', fetch: scripted([
      { content: '', tool_calls: [call('write_file', { path: 'a.txt', content: 'pwned' }), call('delete_file', { path: 'a.txt' })] },
      { content: 'done' },
    ], payloads) });
    assert.deepEqual(payloads[0].tools.map((t: any) => t.function.name), ['list_dir', 'read_file', 'search']);
    assert.match(payloads[1].messages[3].content, /not available in the read-only sandbox/);
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'hello world\n');
    assert.deepEqual(result.files_changed, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace tools confine paths, block .git writes and report errors as tool output', async () => {
  const dir = await tempWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), 'local-outside-'));
  try {
    const ws = await LocalWorkspace.open(dir, 'workspace-write');
    for (const target of ['../escape.txt', path.join(outside, 'x.txt'), 'sub/../../escape.txt'])
      assert.match(await ws.run('write_file', { path: target, content: 'x' }), /^ERROR: Path is outside the workspace/);
    assert.match(await ws.run('read_file', { path: '..' }), /^ERROR: Path is outside/);
    assert.match(await ws.run('write_file', { path: '.git/config', content: 'x' }), /\.git is not allowed/);
    assert.match(await ws.run('edit_file', { path: 'a.txt', old_string: 'missing', new_string: 'y' }), /not found/);
    await writeFile(path.join(dir, 'b.txt'), 'aa');
    assert.match(await ws.run('edit_file', { path: 'b.txt', old_string: 'a', new_string: 'b' }), /matches 2 times/);
    assert.match(await ws.run('edit_file', { path: 'b.txt', old_string: 'a', new_string: '$&b', replace_all: true }), /Edited b.txt/);
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), '$&b$&b');
    assert.match(await ws.run('delete_file', { path: '.' }), /^ERROR/);
    assert.match(await ws.run('nope', {}), /Unknown tool/);
    assert.match(await ws.run('search', { pattern: 'hello', glob: '*.txt' }), /^a\.txt:1: hello world/);
    assert.match(await ws.run('list_dir', { path: '.' }), /a\.txt/);
    await mkdir(path.join(outside, 'target'));
    let linked = true;
    try { await symlink(path.join(outside, 'target'), path.join(dir, 'link'), 'junction'); } catch { linked = false; }
    if (linked) assert.match(await ws.run('write_file', { path: 'link/x.txt', content: 'x' }), /outside the workspace through a link/);
    assert.deepEqual([...ws.changed], ['b.txt']);
    await assert.rejects(LocalWorkspace.open(path.join(dir, 'missing'), 'read-only'), /does not exist/);
    await assert.rejects(LocalWorkspace.open('relative', 'read-only'), /absolute/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('agent loop stops at max_steps and honors abort mid-loop', async () => {
  const dir = await tempWorkspace();
  try {
    const looping = scripted([{ content: '', tool_calls: [call('list_dir', { path: '.' })] }]);
    const result = await invokeLocal({ task: 'x', workDir: dir, maxSteps: 2, fetch: looping });
    assert.equal(result.done_reason, 'max_steps');
    assert.equal(result.steps, 2);
    const controller = new AbortController();
    let chats = 0;
    const aborting: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/chat') && ++chats === 2) controller.abort();
      return looping(url, init);
    };
    await assert.rejects(invokeLocal({ task: 'x', workDir: dir, signal: controller.signal, fetch: aborting }), { name: 'AbortError' });
    assert.equal(chats, 2);
    assert.equal((await invokeLocal({ task: 'next', fetch: fakeFetch() })).verified, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('handler passes work_dir through and reports bad work_dir as an error', async t => {
  const dir = await tempWorkspace();
  try {
    t.mock.method(globalThis, 'fetch', scripted([{ content: '', tool_calls: [call('delete_file', { path: 'a.txt' })] }, { content: 'ok' }]));
    const response = await handleInvokeLocal({ task: 'x', work_dir: dir });
    const result = JSON.parse(response.content[0].text);
    assert.deepEqual(result.files_changed, ['a.txt']);
    assert.equal(result.sandbox, 'workspace-write');
    const missing = await handleInvokeLocal({ task: 'x', work_dir: path.join(dir, 'nope') });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /does not exist/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
