import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * File tools for the local Ollama agent loop. Every path is confined to
 * work_dir in Node (lexically and after resolving symlinks/junctions); there
 * is deliberately no shell tool.
 */
export type LocalSandbox = 'read-only' | 'workspace-write';

const MAX_READ_BYTES = 50_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 500;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

const READ_SCHEMAS = [
  fn('list_dir', 'List entries of a directory inside the workspace. Directories end with "/".', { path: str('Relative directory path; "." is the workspace root.') }, ['path']),
  fn('read_file', 'Read a text file with 1-based line numbers.', {
    path: str('Relative file path.'), offset: int('First line to return (1-based, default 1).'), limit: int('Maximum lines to return (default 2000).'),
  }, ['path']),
  fn('search', 'Search file contents with a JavaScript regular expression. Skips .git, node_modules and dist.', {
    pattern: str('Regular expression.'), path: str('Relative directory to search (default ".").'), glob: str('Optional file glob, e.g. "*.ts" or "src/**/*.md".'),
  }, ['pattern']),
];
const WRITE_SCHEMAS = [
  fn('write_file', 'Create or overwrite a file with the full content. Parent directories are created.', { path: str('Relative file path.'), content: str('Complete new file content.') }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true.', {
    path: str('Relative file path.'), old_string: str('Exact text to replace.'), new_string: str('Replacement text.'), replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
  }, ['path', 'old_string', 'new_string']),
  fn('delete_file', 'Delete a single file (not directories).', { path: str('Relative file path.') }, ['path']),
];

export function localToolSchemas(sandbox: LocalSandbox) {
  return sandbox === 'workspace-write' ? [...READ_SCHEMAS, ...WRITE_SCHEMAS] : READ_SCHEMAS;
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function existingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try { return await realpath(current); } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error('No existing ancestor directory.');
      current = parent;
    }
  }
}

export class LocalWorkspace {
  readonly changed = new Set<string>();
  private constructor(readonly root: string, readonly sandbox: LocalSandbox) {}

  static async open(workDir: string, sandbox: LocalSandbox) {
    if (!path.isAbsolute(workDir)) throw new Error('work_dir must be an absolute path.');
    const info = await stat(workDir).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`work_dir does not exist or is not a directory: ${workDir}`);
    return new LocalWorkspace(await realpath(workDir), sandbox);
  }

  /** Resolve a model-supplied path, rejecting anything that escapes the workspace. */
  async resolve(input: unknown, write = false): Promise<{ full: string; relative: string }> {
    if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string.');
    const full = path.resolve(this.root, input);
    if (!inside(this.root, full)) throw new Error(`Path is outside the workspace: ${input}`);
    if (!inside(this.root, await existingAncestor(full))) throw new Error(`Path resolves outside the workspace through a link: ${input}`);
    const relative = path.relative(this.root, full).split(path.sep).join('/') || '.';
    if (write && relative.split('/')[0].toLowerCase() === '.git') throw new Error('Writing inside .git is not allowed.');
    return { full, relative };
  }

  /** Run one tool call; failures become text for the model instead of throwing. */
  async run(name: string, rawArgs: unknown): Promise<string> {
    try {
      const args = (typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {}) as Record<string, unknown>;
      if (WRITE_TOOLS.has(name) && this.sandbox !== 'workspace-write') throw new Error(`${name} is not available in the read-only sandbox.`);
      switch (name) {
        case 'list_dir': return await this.listDir(args);
        case 'read_file': return await this.readFile(args);
        case 'search': return await this.search(args);
        case 'write_file': return await this.writeFile(args);
        case 'edit_file': return await this.editFile(args);
        case 'delete_file': return await this.deleteFile(args);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async listDir(args: Record<string, unknown>) {
    const { full, relative } = await this.resolve(args.path ?? '.');
    const entries = await readdir(full, { withFileTypes: true });
    const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
    const shown = lines.slice(0, MAX_LIST_ENTRIES);
    return `${relative}:\n${shown.join('\n') || '(empty)'}${lines.length > shown.length ? `\n… ${lines.length - shown.length} more` : ''}`;
  }

  private async readFile(args: Record<string, unknown>) {
    const { full } = await this.resolve(args.path);
    const lines = (await readFile(full, 'utf8')).split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.max(1, Number(args.limit ?? 2000) || 2000);
    let out = '';
    let index = offset - 1;
    for (; index < Math.min(lines.length, offset - 1 + limit); index++) {
      const line = `${index + 1}\t${lines[index]}\n`;
      if (out.length + line.length > MAX_READ_BYTES) break;
      out += line;
    }
    if (index < lines.length) out += `… truncated at line ${index}; ${lines.length} lines total. Use offset to read more.`;
    return out || '(empty file)';
  }

  private async search(args: Record<string, unknown>) {
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern must be a non-empty string.');
    const regex = new RegExp(args.pattern);
    const glob = typeof args.glob === 'string' && args.glob ? globToRegExp(args.glob) : undefined;
    const matchPath = typeof args.glob === 'string' && args.glob.includes('/');
    const { full } = await this.resolve(args.path ?? '.');
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(child); continue; }
        if (!entry.isFile()) continue;
        const relative = path.relative(this.root, child).split(path.sep).join('/');
        if (glob && !glob.test(matchPath ? relative : entry.name)) continue;
        if ((await stat(child)).size > MAX_SEARCH_FILE_BYTES) continue;
        const text = await readFile(child, 'utf8');
        if (text.includes('\0')) continue;
        text.split(/\r?\n/).forEach((line, i) => {
          if (results.length < MAX_SEARCH_RESULTS && regex.test(line)) results.push(`${relative}:${i + 1}: ${line.slice(0, 300)}`);
        });
      }
    };
    await walk(full);
    return results.length ? results.join('\n') + (results.length >= MAX_SEARCH_RESULTS ? '\n… result limit reached' : '') : 'No matches.';
  }

  private async writeFile(args: Record<string, unknown>) {
    if (typeof args.content !== 'string') throw new Error('content must be a string.');
    const { full, relative } = await this.resolve(args.path, true);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, args.content, 'utf8');
    this.changed.add(relative);
    return `Wrote ${relative} (${Buffer.byteLength(args.content)} bytes).`;
  }

  private async editFile(args: Record<string, unknown>) {
    const { old_string: oldText, new_string: newText } = args;
    if (typeof oldText !== 'string' || !oldText) throw new Error('old_string must be a non-empty string.');
    if (typeof newText !== 'string') throw new Error('new_string must be a string.');
    const { full, relative } = await this.resolve(args.path, true);
    const text = await readFile(full, 'utf8');
    const count = text.split(oldText).length - 1;
    if (count === 0) throw new Error('old_string was not found in the file.');
    if (count > 1 && args.replace_all !== true) throw new Error(`old_string matches ${count} times; add context or set replace_all.`);
    await writeFile(full, args.replace_all === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText), 'utf8');
    this.changed.add(relative);
    return `Edited ${relative} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? 's' : ''}).`;
  }

  private async deleteFile(args: Record<string, unknown>) {
    const { full, relative } = await this.resolve(args.path, true);
    if (!(await stat(full)).isFile()) throw new Error('delete_file only deletes files.');
    await rm(full);
    this.changed.add(relative);
    return `Deleted ${relative}.`;
  }
}

function globToRegExp(glob: string) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { source += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}
