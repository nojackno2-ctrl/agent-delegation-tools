import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { ExecutionResult, EXIT_CODES } from './types.js';

// taskkill /T relies on process discovery that restricted Windows tokens can
// deny. Toolhelp snapshots enumerate descendants without requiring WMI access.
const WINDOWS_TREE_KILL_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DelegationTreeKill {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Kill(uint root) {
    var children = new Dictionary<uint,List<uint>>();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot != new IntPtr(-1)) {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (Process32FirstW(snapshot, ref entry)) do {
        if (!children.ContainsKey(entry.parent)) children[entry.parent] = new List<uint>();
        children[entry.parent].Add(entry.pid);
      } while (Process32NextW(snapshot, ref entry));
      CloseHandle(snapshot);
    }
    KillDescendants(root, children, new HashSet<uint>());
  }
  static void KillDescendants(uint pid, Dictionary<uint,List<uint>> children, HashSet<uint> seen) {
    if (!seen.Add(pid)) return;
    if (children.ContainsKey(pid)) foreach (var child in children[pid]) KillDescendants(child, children, seen);
    var handle = OpenProcess(1, false, pid);
    if (handle != IntPtr.Zero) { TerminateProcess(handle, 130); CloseHandle(handle); }
  }
}`;

function killWindowsTreeFallback(pid: number): void {
  const directKill = () => { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } };
  const script = `Add-Type -TypeDefinition @'\n${WINDOWS_TREE_KILL_SOURCE}\n'@\n[DelegationTreeKill]::Kill(${pid})`;
  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    helper.on('error', directKill);
    helper.on('exit', directKill);
    helper.unref();
  } catch { directKill(); }
}

export function formatWindowsArgument(val: string): string {
  if (val === '') return '""';
  if (!/[\s"]/.test(val)) return val;
  const escaped = val.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

export function killProcessTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => killWindowsTreeFallback(pid));
      child.on('exit', (code) => {
        if (code !== 0) {
          killWindowsTreeFallback(pid);
        }
      });
      child.unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

export interface SpawnProcessOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinString?: string;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}

export async function spawnProcess(options: SpawnProcessOptions): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (options.signal?.aborted) {
    return { exitCode: EXIT_CODES.CANCELLED, stdout: '', stderr: 'Process cancelled before spawn.', durationMs: 0, cancelled: true };
  }

  // Recursion guard
  const depth = parseInt(process.env.AGENT_DELEGATION_DEPTH || '0', 10);
  if (depth >= 1) {
    return {
      exitCode: EXIT_CODES.ALL_DEPLETED,
      stdout: '',
      stderr: `Refusing recursive delegation: AGENT_DELEGATION_DEPTH=${depth}.`,
      durationMs: 0,
    };
  }

  const isCmdOrBat = /\.(cmd|bat)$/i.test(options.executable);
  let launchExecutable = options.executable;
  let launchArgs = options.args;

  if (isCmdOrBat && process.platform === 'win32') {
    const comSpec = process.env.ComSpec || 'cmd.exe';
    launchExecutable = comSpec;
    const innerArgs = [options.executable, ...options.args].map(formatWindowsArgument).join(' ');
    launchArgs = ['/d', '/s', '/c', `"${innerArgs}"`];
  }

  return new Promise<ExecutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launchExecutable, launchArgs, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          ...options.env,
          AGENT_DELEGATION_DEPTH: String(depth + 1),
          PYTHONUTF8: '1',
        },
        stdio: [options.stdinString !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: isCmdOrBat && process.platform === 'win32',
        detached: process.platform !== 'win32',
      });
    } catch (err: any) {
      resolve({
        exitCode: EXIT_CODES.GENERIC_FAILURE,
        stdout: '',
        stderr: `Failed to spawn process: ${err?.message || String(err)}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const abort = () => {
      if (timedOut || cancelled) return;
      cancelled = true;
      if (child.pid) killProcessTree(child.pid);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    let timeoutTimer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (cancelled) return;
        timedOut = true;
        if (child.pid) {
          killProcessTree(child.pid);
        }
      }, options.timeoutMs);
    }

    if (child.stdin && options.stdinString !== undefined) {
      child.stdin.on('error', () => { /* child may close stdin during cancellation */ });
      child.stdin.write(options.stdinString, 'utf8');
      child.stdin.end();
    }

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      if (options.onStdout) options.onStdout(chunk.toString('utf8'));
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      if (options.onStderr) options.onStderr(chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', abort);
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: cancelled ? EXIT_CODES.CANCELLED : EXIT_CODES.GENERIC_FAILURE,
        cancelled,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `Child process error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
        durationMs,
      });
    });

    child.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', abort);
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (cancelled) {
        resolve({ exitCode: EXIT_CODES.CANCELLED, stdout, stderr: `Process cancelled.\n${stderr}`, durationMs, cancelled: true });
      } else if (timedOut) {
        resolve({
          exitCode: EXIT_CODES.TIMEOUT,
          stdout,
          stderr: `Process timed out after ${options.timeoutMs}ms.\n${stderr}`,
          durationMs,
          timedOut: true,
        });
      } else {
        resolve({
          exitCode: code ?? EXIT_CODES.SUCCESS,
          stdout,
          stderr,
          durationMs,
        });
      }
    });
  });
}
