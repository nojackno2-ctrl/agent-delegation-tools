import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { killProcessTree, resolveWindowsSpawnSpec } from './process.js';
import { ExecutionResult, EXIT_CODES } from './types.js';

export interface AcpPromptOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modeId?: string;
  prompt: string;
  skipPermissions?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: () => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

function extractChunkText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractChunkText).join('');
  }
  if (content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function pickPermissionOptionId(options: any[]): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const allowAlways = options.find((opt) => opt?.kind === 'allow_always');
  if (allowAlways?.optionId) return allowAlways.optionId;
  const allowOnce = options.find((opt) => opt?.kind === 'allow_once');
  if (allowOnce?.optionId) return allowOnce.optionId;
  return options[0]?.optionId;
}

export async function runAcpPrompt(options: AcpPromptOptions): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (options.signal?.aborted) {
    return {
      exitCode: EXIT_CODES.CANCELLED,
      stdout: '',
      stderr: 'Process cancelled before spawn.',
      durationMs: 0,
      cancelled: true,
    };
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

  const launchSpec = resolveWindowsSpawnSpec(options.executable, options.args);

  return new Promise<ExecutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launchSpec.executable, launchSpec.args, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          ...options.env,
          AGENT_DELEGATION_DEPTH: String(depth + 1),
          PYTHONUTF8: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launchSpec.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
      });
    } catch (err: any) {
      resolve({
        exitCode: EXIT_CODES.GENERIC_FAILURE,
        stdout: '',
        stderr: `Failed to spawn ACP process: ${err?.message || String(err)}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let gracefulShutdown = false;
    let sessionId: string | undefined;
    let nextId = 1;
    let stdoutBuf = '';
    const stdoutDecoder = new StringDecoder('utf8');

    const assistantChunks: string[] = [];
    const rawStdoutLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    const pending = new Map<number | string, PendingRequest>();

    let timeoutTimer: NodeJS.Timeout | null = null;
    let killGraceTimer: NodeJS.Timeout | null = null;

    const rejectAllPending = (err: Error) => {
      for (const [, req] of pending) {
        req.reject(err);
      }
      pending.clear();
    };

    const sendJsonRpc = (payload: JsonRpcMessage) => {
      if (!child.stdin || !child.stdin.writable) return;
      try {
        child.stdin.write(JSON.stringify(payload) + '\n', 'utf8');
      } catch {
        // ignore write errors during teardown
      }
    };

    const sendRequest = (method: string, params: any): Promise<any> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        if (cancelled || timedOut) {
          rej(new Error(cancelled ? 'ACP request cancelled.' : 'ACP request timed out.'));
          return;
        }
        pending.set(id, { resolve: res, reject: rej });
        sendJsonRpc({ jsonrpc: '2.0', id, method, params });
      });
    };

    const scheduleForceKill = (delayMs: number) => {
      if (killGraceTimer) clearTimeout(killGraceTimer);
      killGraceTimer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
      }, delayMs);
    };

    const beginTeardown = (reason: string) => {
      if (sessionId) {
        sendJsonRpc({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      }
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      rejectAllPending(new Error(reason));
      scheduleForceKill(500);
    };

    const abort = () => {
      if (timedOut || cancelled || settled) return;
      cancelled = true;
      beginTeardown('ACP invocation cancelled.');
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (cancelled || settled) return;
        timedOut = true;
        beginTeardown(`ACP invocation timed out after ${options.timeoutMs}ms.`);
      }, options.timeoutMs);
    }

    child.stdin?.on('error', () => {
      // child may close stdin early
    });

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        rawStdoutLines.push(trimmed);
        options.onProgress?.();
        return;
      }

      if (msg.id !== undefined && msg.method !== undefined) {
        // Server -> client request
        if (msg.method === 'session/request_permission') {
          const optionId =
            options.skipPermissions !== false ? pickPermissionOptionId(msg.params?.options) : undefined;
          sendJsonRpc({
            jsonrpc: '2.0',
            id: msg.id,
            result: optionId
              ? { outcome: { outcome: 'selected', optionId } }
              : { outcome: { outcome: 'cancelled' } },
          });
        } else {
          sendJsonRpc({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          });
        }
        return;
      }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          if (msg.error) {
            const detail = msg.error.data ? ` (${JSON.stringify(msg.error.data)})` : '';
            req.reject(new Error(`ACP error ${msg.error.code ?? -1}: ${msg.error.message || 'Unknown error'}${detail}`));
          } else {
            req.resolve(msg.result);
          }
        }
        return;
      }

      if (msg.method === 'session/update') {
        options.onProgress?.();
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const text = extractChunkText(update.content);
          if (text) assistantChunks.push(text);
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += stdoutDecoder.write(chunk);
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      options.onProgress?.();
    });

    let rpcError: Error | null = null;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      options.signal?.removeEventListener('abort', abort);

      stdoutBuf += stdoutDecoder.end();
      if (stdoutBuf.trim()) {
        handleLine(stdoutBuf);
        stdoutBuf = '';
      }

      const durationMs = Date.now() - startTime;
      const stdout = assistantChunks.length > 0 ? assistantChunks.join('') : rawStdoutLines.join('\n');
      const stderrRaw = Buffer.concat(stderrChunks).toString('utf8');
      const stderr = rpcError ? [rpcError.message, stderrRaw].filter(Boolean).join('\n') : stderrRaw;

      if (cancelled) {
        resolve({
          exitCode: EXIT_CODES.CANCELLED,
          stdout,
          stderr: `Process cancelled.\n${stderr}`,
          durationMs,
          cancelled: true,
        });
      } else if (timedOut) {
        resolve({
          exitCode: EXIT_CODES.TIMEOUT,
          stdout,
          stderr: `Process timed out after ${options.timeoutMs}ms.\n${stderr}`,
          durationMs,
          timedOut: true,
        });
      } else if (gracefulShutdown && !rpcError) {
        resolve({
          exitCode: EXIT_CODES.SUCCESS,
          stdout,
          stderr,
          durationMs,
        });
      } else {
        const earlyExitMsg = !gracefulShutdown && !rpcError
          ? `ACP process exited before prompt completed (code ${code ?? 'null'}).`
          : '';
        const finalStderr = [earlyExitMsg, stderr].filter(Boolean).join('\n');
        resolve({
          exitCode: code && code !== 0 ? code : EXIT_CODES.GENERIC_FAILURE,
          stdout,
          stderr: finalStderr,
          durationMs,
        });
      }
    };

    child.on('error', (err) => {
      rpcError = err;
      rejectAllPending(err);
      finish(EXIT_CODES.GENERIC_FAILURE);
    });

    child.on('close', (code) => {
      rejectAllPending(new Error(`ACP process exited with code ${code ?? 'null'}`));
      finish(code);
    });

    // Run ACP handshake + prompt
    (async () => {
      try {
        await sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'agent-delegation-mcp', version: '1.1.0' },
        });

        const sessionResult = await sendRequest('session/new', {
          cwd: options.cwd,
          mcpServers: [],
        });

        sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          throw new Error('ACP session/new did not return a sessionId.');
        }

        if (options.modelId) {
          const availableModels: Array<{ modelId?: string }> = sessionResult?.models?.availableModels || [];
          let targetModelId = options.modelId;
          if (availableModels.length > 0 && !availableModels.some((m) => m.modelId === targetModelId)) {
            const xhighFallback = targetModelId.replace(/-max$/i, '-xhigh');
            const highFallback = targetModelId.replace(/-(?:max|xhigh)$/i, '-high');
            if (availableModels.some((m) => m.modelId === xhighFallback)) {
              targetModelId = xhighFallback;
            } else if (availableModels.some((m) => m.modelId === highFallback)) {
              targetModelId = highFallback;
            }
          }
          await sendRequest('session/set_model', { sessionId, modelId: targetModelId });
        }

        if (options.modeId) {
          await sendRequest('session/set_mode', { sessionId, modeId: options.modeId });
        }

        await sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: options.prompt }],
        });

        gracefulShutdown = true;
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        scheduleForceKill(1000);
      } catch (err: any) {
        if (!cancelled && !timedOut) {
          rpcError = err instanceof Error ? err : new Error(String(err));
          try {
            child.stdin?.end();
          } catch {
            // ignore
          }
          scheduleForceKill(500);
        }
      }
    })();
  });
}
