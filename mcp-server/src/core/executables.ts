import * as fs from 'node:fs';
import * as path from 'node:path';

const executableCache = new Map<string, string>();

export function clearExecutableCache(): void {
  executableCache.clear();
}

function findOnPath(executableName: string): string | null {
  const envPath = process.env.PATH || '';
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const pathDirs = envPath.split(path.delimiter);

  for (const dir of pathDirs) {
    if (!dir) continue;
    // Check exact name or with extensions
    const hasExt = path.extname(executableName).length > 0;
    if (hasExt) {
      const full = path.join(dir, executableName);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return full;
      }
    } else {
      for (const ext of extensions) {
        const full = path.join(dir, `${executableName}${ext}`);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
  }
  return null;
}

export function resolveCodexExecutable(requestedPath?: string): string {
  if (requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    return path.resolve(requestedPath);
  }
  const cached = executableCache.get('codex');
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  let resolved: string | null = null;
  if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
    resolved = path.resolve(process.env.CODEX_CLI_PATH);
  } else if (process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, '.sandbox-bin', 'codex.exe'))) {
    resolved = path.join(process.env.CODEX_HOME, '.sandbox-bin', 'codex.exe');
  } else if (process.env.USERPROFILE && fs.existsSync(path.join(process.env.USERPROFILE, '.codex', '.sandbox-bin', 'codex.exe'))) {
    resolved = path.join(process.env.USERPROFILE, '.codex', '.sandbox-bin', 'codex.exe');
  } else if (process.env.LOCALAPPDATA) {
    const binRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(binRoot)) {
      try {
        const subdirs = fs.readdirSync(binRoot);
        let newestFile: string | null = null;
        let newestMtime = 0;
        for (const sub of subdirs) {
          const exePath = path.join(binRoot, sub, 'codex.exe');
          if (fs.existsSync(exePath)) {
            const mtime = fs.statSync(exePath).mtimeMs;
            if (mtime > newestMtime) {
              newestMtime = mtime;
              newestFile = exePath;
            }
          }
        }
        if (newestFile) resolved = newestFile;
      } catch {
        // ignore
      }
    }
  }

  if (!resolved) {
    resolved = findOnPath('codex');
  }

  if (resolved) {
    executableCache.set('codex', resolved);
    return resolved;
  }

  throw new Error('Codex CLI executable was not found. Configure CODEX_CLI_PATH or install Codex Desktop.');
}

export function resolveAgyExecutable(requestedPath?: string): string {
  if (requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    return path.resolve(requestedPath);
  }
  const cached = executableCache.get('agy');
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  let resolved: string | null = null;
  if (process.env.AGY_CLI_PATH && fs.existsSync(process.env.AGY_CLI_PATH)) {
    resolved = path.resolve(process.env.AGY_CLI_PATH);
  } else if (process.env.LOCALAPPDATA) {
    const defaultPath = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(defaultPath)) resolved = defaultPath;
  }

  if (!resolved) {
    resolved = findOnPath('agy');
  }

  if (resolved) {
    executableCache.set('agy', resolved);
    return resolved;
  }

  throw new Error('Antigravity CLI (agy) executable was not found. Configure AGY_CLI_PATH or install Antigravity.');
}

export function resolveClaudeExecutable(requestedPath?: string): string {
  if (requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    return path.resolve(requestedPath);
  }
  const cached = executableCache.get('claude');
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  let resolved: string | null = null;
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
    resolved = path.resolve(process.env.CLAUDE_CLI_PATH);
  } else {
    resolved = findOnPath('claude');
    if (!resolved && process.env.USERPROFILE) {
      const localBin = path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe');
      if (fs.existsSync(localBin)) resolved = localBin;
    }
  }

  if (resolved) {
    executableCache.set('claude', resolved);
    return resolved;
  }

  throw new Error('Claude Code CLI executable was not found. Configure CLAUDE_CLI_PATH or install Claude Code.');
}
