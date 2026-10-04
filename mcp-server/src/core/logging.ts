import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_OUTPUT_CHARS = 20000;

export function getLogsDir(): string {
  const dir = path.join(os.tmpdir(), 'agent-delegation-logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeRunLog(id: string, agent: string, stdout: string, stderr: string): string {
  const logDir = getLogsDir();
  const filename = `${id}-${agent}.log`;
  const filePath = path.join(logDir, filename);
  const content = [
    `=== AGENT: ${agent} ===`,
    `=== RUN ID: ${id} ===`,
    `=== TIMESTAMP: ${new Date().toISOString()} ===`,
    '=== STDOUT ===',
    stdout,
    '=== STDERR ===',
    stderr,
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function capOutputTail(text: string, maxChars = MAX_OUTPUT_CHARS, logPath?: string): string {
  if (!text || text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const notice = logPath
    ? `[Output truncated to last ${maxChars} chars. Full log: ${logPath}]\n... `
    : `[Output truncated to last ${maxChars} chars]\n... `;
  return notice + tail;
}

export function truncateTail(text: string, maxChars = 1500): string {
  if (!text || text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

export function generateRunId(): string {
  return randomBytes(4).toString('hex');
}
