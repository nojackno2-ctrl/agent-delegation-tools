import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexLocalProfile, DEFAULT_LOCAL_MODEL, DEFAULT_MODELS } from '../core/defaults.js';
import { invokeCodex } from '../services/invokers/codex-invoker.js';

/** Fake Codex that prints its argv as JSON. */
function argvCli(dir: string): string {
  const script = path.join(dir, 'argv.cjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const executable = path.join(dir, 'codex' + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return executable;
}

test('codexLocalProfile only matches allowed local models and honors CODEX_LOCAL_PROFILE', () => {
  const saved = { models: process.env.LOCAL_AI_MODELS, profile: process.env.CODEX_LOCAL_PROFILE };
  try {
    delete process.env.LOCAL_AI_MODELS;
    delete process.env.CODEX_LOCAL_PROFILE;
    assert.equal(codexLocalProfile(DEFAULT_LOCAL_MODEL), 'ollama');
    assert.equal(codexLocalProfile(DEFAULT_MODELS.codex.model), undefined);
    assert.equal(codexLocalProfile(undefined), undefined);
    assert.equal(codexLocalProfile('extra-local'), undefined);
    process.env.LOCAL_AI_MODELS = ' extra-local ,';
    process.env.CODEX_LOCAL_PROFILE = 'my-ollama';
    assert.equal(codexLocalProfile('extra-local'), 'my-ollama');
  } finally {
    if (saved.models === undefined) delete process.env.LOCAL_AI_MODELS; else process.env.LOCAL_AI_MODELS = saved.models;
    if (saved.profile === undefined) delete process.env.CODEX_LOCAL_PROFILE; else process.env.CODEX_LOCAL_PROFILE = saved.profile;
  }
});

test('invokeCodex adds -p ollama for local models and leaves OpenAI models untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-local-'));
  try {
    const codexPath = argvCli(dir);
    const local = JSON.parse((await invokeCodex({ prompt: 'x', model: DEFAULT_LOCAL_MODEL, codexPath, workDir: dir })).output!);
    assert.deepEqual(local.slice(0, 3), ['exec', '-p', 'ollama']);
    assert.equal(local[local.indexOf('-m') + 1], DEFAULT_LOCAL_MODEL);
    const cloud = JSON.parse((await invokeCodex({ prompt: 'x', codexPath, workDir: dir })).output!);
    assert.equal(cloud.includes('-p'), false);
    assert.equal(cloud[cloud.indexOf('-m') + 1], DEFAULT_MODELS.codex.model);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
