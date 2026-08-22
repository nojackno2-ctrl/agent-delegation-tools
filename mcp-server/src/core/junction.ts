import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface DirectoryResolution {
  effectivePath: string;
  originalPath: string;
  isJunction: boolean;
  cleanup: () => void;
}

export function hasNonAscii(str: string): boolean {
  return /[^\x00-\x7F]/.test(str);
}

export function ensureAsciiDirectory(targetDir: string, customAliasRoot?: string): DirectoryResolution {
  const normalizedTarget = path.resolve(targetDir);

  if (!fs.existsSync(normalizedTarget)) {
    throw new Error(`Target directory does not exist: ${normalizedTarget}`);
  }

  if (process.platform !== 'win32' || !hasNonAscii(normalizedTarget)) {
    return {
      effectivePath: normalizedTarget,
      originalPath: normalizedTarget,
      isJunction: false,
      cleanup: () => {},
    };
  }

  // Target directory contains non-ASCII characters. Create an NTFS junction in an ASCII location.
  const aliasRoot = customAliasRoot || path.join(process.env.USERPROFILE || 'C:\\', 'codex-ws');
  if (!fs.existsSync(aliasRoot)) {
    fs.mkdirSync(aliasRoot, { recursive: true });
  }

  const hash = crypto.createHash('sha256').update(normalizedTarget.toLowerCase()).digest('hex').substring(0, 12);
  const junctionPath = path.join(aliasRoot, hash);

  let junctionCreated = false;
  if (!fs.existsSync(junctionPath)) {
    try {
      fs.symlinkSync(normalizedTarget, junctionPath, 'junction');
      junctionCreated = true;
    } catch {
      // If junction creation fails, fallback to original path
      return {
        effectivePath: normalizedTarget,
        originalPath: normalizedTarget,
        isJunction: false,
        cleanup: () => {},
      };
    }
  }

  return {
    effectivePath: junctionPath,
    originalPath: normalizedTarget,
    isJunction: true,
    cleanup: () => {
      if (junctionCreated && fs.existsSync(junctionPath)) {
        try {
          fs.unlinkSync(junctionPath);
        } catch {
          // ignore cleanup errors
        }
      }
    },
  };
}
