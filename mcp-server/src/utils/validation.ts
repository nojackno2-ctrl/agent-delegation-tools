import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkDirValidationResult {
  valid: boolean;
  error?: string;
  path?: string;
}

export function validateWorkDir(workDir: unknown): WorkDirValidationResult {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    return { valid: false, error: 'work_dir is required and must be a non-empty string path.' };
  }
  if (!path.isAbsolute(workDir)) {
    return { valid: false, error: `work_dir must be an absolute path: received "${workDir}".` };
  }
  try {
    if (!fs.existsSync(workDir)) {
      return { valid: false, error: `work_dir does not exist: "${workDir}".` };
    }
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return { valid: false, error: `work_dir is not a directory: "${workDir}".` };
    }
  } catch (err: any) {
    return { valid: false, error: `Failed to inspect work_dir "${workDir}": ${err?.message || String(err)}` };
  }
  return { valid: true, path: workDir };
}
