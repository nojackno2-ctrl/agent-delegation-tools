import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnProcess } from '../core/process.js';
import { EXIT_CODES } from '../core/types.js';
import { beforeEach, afterEach } from 'node:test';

let inheritedDepth: string | undefined;
beforeEach(() => { inheritedDepth = process.env.AGENT_DELEGATION_DEPTH; process.env.AGENT_DELEGATION_DEPTH = '0'; });
afterEach(() => {
  if (inheritedDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
  else process.env.AGENT_DELEGATION_DEPTH = inheritedDepth;
});

test('already-aborted signal does not spawn even an invalid executable', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await spawnProcess({ executable: 'invalid-do-not-spawn', args: [], signal: controller.signal });
  assert.equal(result.exitCode, EXIT_CODES.CANCELLED);
  assert.equal(result.cancelled, true);
  assert.equal(result.durationMs, 0);
});

test('mid-run abort terminates the fake child and retains output', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let pid = 0;
  const result = await spawnProcess({
    executable: process.execPath,
    args: ['-e', 'console.log(process.pid); setTimeout(()=>{},60000)'],
    signal: controller.signal,
    onStdout: (data) => { pid = Number(data.trim()); controller.abort(); },
  });
  assert.ok(pid > 0);
  assert.equal(result.exitCode, EXIT_CODES.CANCELLED);
  assert.equal(result.cancelled, true);
  assert.match(result.stdout, new RegExp(String(pid)));
  assert.throws(() => process.kill(pid, 0));
});

test('spawnProcess invokes stdout and stderr activity callbacks', async () => {
  const activity: string[] = [];
  const result = await spawnProcess({
    executable: process.execPath,
    args: ['-e', 'console.log("stdout activity");console.error("stderr activity")'],
    onStdout: (data) => activity.push(data), onStderr: (data) => activity.push(data),
  });
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(activity.length, 2);
  assert.match(activity.join(''), /stdout activity/);
  assert.match(activity.join(''), /stderr activity/);
});

test('abort kills both parent and nested fake child process', { timeout: 15000 }, async () => {
  const controller = new AbortController();
  let output = '';
  const pids: number[] = [];
  const nestedCode = 'console.log("nested:"+process.pid);setTimeout(()=>{},60000)';
  const parentCode = `console.log("parent:"+process.pid);require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(nestedCode)}],{stdio:'inherit'});setTimeout(()=>{},60000)`;
  try {
    const result = await spawnProcess({
      executable: process.execPath, args: ['-e', parentCode], signal: controller.signal,
      onStdout: (data) => {
        output += data;
        const found = Array.from(output.matchAll(/(?:parent|nested):(\d+)/g), (match) => Number(match[1]));
        if (found.length === 2) { pids.push(...found); controller.abort(); }
      },
    });
    assert.equal(result.exitCode, EXIT_CODES.CANCELLED);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `fake pid ${pid} must be dead`);
  } finally {
    controller.abort();
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
});
