import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { getAgyQuota, readAgyCliUsage, parseAgyCliUsageOutput, parseAgyUsageResponse } from '../services/quota/agy-quota.js';
import { clearExecutableCache } from '../core/executables.js';

const weekly = 'Gemini Models\tWeekly Limit Remaining\t91%\t2026-10-04T02:50:34Z';
const fiveHour = 'Gemini Models\tFive Hour Limit Remaining\t90%\t2026-10-03T19:17:22Z';

it('uses only the built-in usage command, closes stdin, and preserves recursion depth', async () => {
  const originalDepth = process.env.AGENT_DELEGATION_DEPTH;
  process.env.AGENT_DELEGATION_DEPTH = '1';
  let closed = false;
  const stub = mock.method(childProcess, 'execFile', (...args: any[]) => {
    assert.equal(args[0], 'agy.exe');
    assert.deepEqual(args[1], ['-p', '/usage', '--output-format', 'text', '--print-timeout', '15s']);
    assert.equal(args[2].timeout, 15000);
    assert.equal(args[2].env, undefined); // inherit, never reset/increment guard
    args[3](null, weekly, fiveHour);
    return { stdin: { end() { closed = true; } } };
  });
  try {
    const report = parseAgyCliUsageOutput(await readAgyCliUsage('agy.exe', 15), 'now');
    assert.equal(report.availability, 'available');
    assert.deepEqual(report.windows?.map(w => w.windowDurationMins), [10080, 300]);
    assert.equal(closed, true);
    assert.equal(process.env.AGENT_DELEGATION_DEPTH, '1');
  } finally {
    stub.mock.restore();
    if (originalDepth === undefined) delete process.env.AGENT_DELEGATION_DEPTH;
    else process.env.AGENT_DELEGATION_DEPTH = originalDepth;
  }
});

it('rejects a failed or timed-out process even if it printed a weekly row', async () => {
  const stub = mock.method(childProcess, 'execFile', (...args: any[]) => {
    args[3]({ killed: true, code: null, message: 'deadline' }, weekly, '');
    return { stdin: { end() {} } };
  });
  try {
    await assert.rejects(readAgyCliUsage('agy.exe', 1), /timed out after 1s/);
  } finally { stub.mock.restore(); }
});

it('keeps five-hour-only CLI and LS data out of weekly routing', () => {
  const report = parseAgyCliUsageOutput(fiveHour, 'now');
  assert.equal(report.availability, 'unavailable');
  assert.equal(report.windows?.[0].windowDurationMins, 300);
  const diagnostic = parseAgyUsageResponse(JSON.stringify({clientModelConfigs: [
    {label: 'Gemini', quotaInfo: {remainingFraction: 0.9}},
  ]}), 'now');
  assert.equal(diagnostic.windows?.[0].windowDurationMins, null);
  assert.ok(!diagnostic.windows?.some(w => w.windowDurationMins === 10080));
});

it('does not add language-server discovery/RPC waits after the CLI consumes the deadline', async () => {
  const originalPath = process.env.AGY_CLI_PATH;
  process.env.AGY_CLI_PATH = process.execPath;
  clearExecutableCache();
  let clock = 1000;
  const now = mock.method(Date, 'now', () => clock);
  const stub = mock.method(childProcess, 'execFile', (...args: any[]) => {
    clock += args[2].timeout;
    args[3]({ killed: true, message: 'deadline' }, '', '');
    return { stdin: { end() {} } };
  });
  try {
    const report = await getAgyQuota({timeoutSec: 1});
    assert.equal(report.availability, 'unavailable');
    assert.match(report.message, /timed out after 1s/);
    assert.deepEqual(report.windows, []);
    assert.equal(stub.mock.callCount(), 1);
  } finally {
    stub.mock.restore();
    now.mock.restore();
    if (originalPath === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = originalPath;
    clearExecutableCache();
  }
});
