import { DEFAULT_LOCAL_MODEL } from '../../core/defaults.js';

const THINK_MODELS = new Set(['laguna-xs-2.1:latest']);
const SYSTEM_PROMPT = 'You are a local task delegate. Complete the supplied task concisely. '
  + 'You have no tools, filesystem or internet access. Never claim to have '
  + "run tests or changed files. Mark uncertainties. Match the task's language. "
  + 'Whenever you write Chinese, use Traditional Chinese as used in Taiwan '
  + '(zh-TW), never Simplified Chinese, and do not add pinyin.';

/** Dependency injection does not bypass the process-wide GPU queue. */
export interface LocalClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
export interface InvokeLocalOptions extends LocalClientOptions {
  task: string;
  context?: string;
  model?: string;
  maxTokens?: number;
  maxOutputChars?: number;
  think?: boolean;
  signal?: AbortSignal;
  timeoutSec?: number;
}

function settings(options: LocalClientOptions) {
  const host = (options.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').trim();
  return {
    baseUrl: (/^https?:\/\//i.test(host) ? host : `http://${host}`).replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch,
    allowed: new Set([DEFAULT_LOCAL_MODEL, ...(process.env.LOCAL_AI_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean)]),
  };
}

interface OllamaResponse {
  models?: { name: string }[];
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function request(options: LocalClientOptions, path: string, signal: AbortSignal, payload?: unknown): Promise<OllamaResponse> {
  const config = settings(options);
  try {
    const response = await config.fetch(`${config.baseUrl}${path}`, {
      method: payload === undefined ? 'GET' : 'POST', signal,
      ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as OllamaResponse;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`Local Ollama request failed; check Ollama at ${config.baseUrl}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function boundedSignal(signal: AbortSignal | undefined, timeoutSec: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(new DOMException('Ollama timed out; reduce task size or check GPU/model load.', 'TimeoutError')), timeoutSec * 1000) : undefined;
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function names(data: { models?: { name: string }[] }, allowed: Set<string>) {
  return (data.models ?? []).map(m => m.name).filter(name => allowed.has(name));
}

export async function listLocalModels(options: LocalClientOptions = {}) {
  const config = settings(options);
  const bound = boundedSignal(undefined, 5);
  const common = { default: DEFAULT_LOCAL_MODEL, base_url: config.baseUrl };
  try {
    const tags = await request(options, '/api/tags', bound.signal);
    const loaded = await request(options, '/api/ps', bound.signal);
    return { ...common, models: names(tags, config.allowed), loaded: names(loaded, config.allowed), reachable: true as const };
  } catch (error) {
    return { ...common, models: [], loaded: [], reachable: false as const, message: `Ollama at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  } finally { bound.dispose(); }
}

let generationQueue: Promise<unknown> = Promise.resolve();

export async function invokeLocal(options: InvokeLocalOptions) {
  if (!options.task.trim()) throw new Error('task must contain non-whitespace text');
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  if (!settings(options).allowed.has(model)) throw new Error(`Requested local model is not allowed: ${model}`);
  const bound = boundedSignal(options.signal, options.timeoutSec ?? 300);
  const signal = bound.signal;
  // Reserve a slot synchronously; failed/cancelled jobs never poison the queue.
  const operation = generationQueue.then(async () => {
    signal.throwIfAborted();
    const tags = await request(options, '/api/tags', signal);
    if (!(tags.models ?? []).some((m: { name: string }) => m.name === model)) throw new Error('Requested local model is not installed.');
    const thinking = (options.think ?? true) && THINK_MODELS.has(model);
    const started = performance.now();
    const response = await request(options, '/api/chat', signal, {
      model, stream: false, keep_alive: '15m',
      ...(THINK_MODELS.has(model) ? { think: thinking } : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Task:\n${options.task}\n\nContext supplied by caller:\n${options.context ?? ''}` },
      ],
      options: { temperature: 0.2, num_predict: (options.maxTokens ?? 1024) + (thinking ? 8192 : 0), num_ctx: 65536 },
    });
    const answer: string = response.message?.content ?? '';
    if (!answer) {
      if (thinking && response.done_reason === 'length') throw new Error('Reasoning used the whole token budget; retry with think=false or a smaller task.');
      throw new Error('Ollama returned no answer.');
    }
    const chars = Array.from(answer);
    return {
      model, answer: chars.slice(0, options.maxOutputChars ?? 6000).join(''), truncated: chars.length > (options.maxOutputChars ?? 6000),
      done_reason: response.done_reason ?? null, thinking,
      prompt_tokens: response.prompt_eval_count ?? 0, generated_tokens: response.eval_count ?? 0,
      elapsed_seconds: Math.round((performance.now() - started) / 10) / 100,
      inference: 'local_ollama' as const, verified: false as const,
    };
  });
  generationQueue = operation.catch(() => {});
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    bound.dispose();
  }
}
