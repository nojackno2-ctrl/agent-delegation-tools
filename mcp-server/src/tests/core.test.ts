import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWindowsArgument } from '../core/process.js';
import { hasNonAscii, ensureAsciiDirectory } from '../core/junction.js';
import { EXIT_CODES } from '../core/types.js';
import { clearExecutableCache } from '../core/executables.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Core Process & Utilities', () => {
  describe('formatWindowsArgument (CommandLineToArgvW rules)', () => {
    it('should format empty string as double quotes', () => {
      assert.equal(formatWindowsArgument(''), '""');
    });

    it('should leave simple alphanumeric strings untouched', () => {
      assert.equal(formatWindowsArgument('simpleArg123'), 'simpleArg123');
      assert.equal(formatWindowsArgument('--flag-name'), '--flag-name');
    });

    it('should wrap arguments with spaces in quotes', () => {
      assert.equal(formatWindowsArgument('hello world'), '"hello world"');
    });

    it('should escape internal double quotes correctly', () => {
      assert.equal(formatWindowsArgument('say "hello" now'), '"say \\"hello\\" now"');
    });

    it('should handle backslashes preceding quotes correctly', () => {
      assert.equal(formatWindowsArgument('C:\\path with spaces\\'), '"C:\\path with spaces\\\\"');
    });
  });

  describe('Exit Codes and Constants', () => {
    it('should conform to the standard agent delegation exit code specification', () => {
      assert.equal(EXIT_CODES.SUCCESS, 0);
      assert.equal(EXIT_CODES.GENERIC_FAILURE, 1);
      assert.equal(EXIT_CODES.QUOTA_EXCEEDED, 10);
      assert.equal(EXIT_CODES.ALL_DEPLETED, 75);
      assert.equal(EXIT_CODES.CONFIG_AUTH_ERROR, 78);
      assert.equal(EXIT_CODES.TIMEOUT, 124);
    });
  });

  describe('hasNonAscii and ensureAsciiDirectory', () => {
    it('should correctly identify ASCII vs non-ASCII strings', () => {
      assert.equal(hasNonAscii('C:\\Users\\john\\project'), false);
      assert.equal(hasNonAscii('C:\\離線儲存\\專案'), true);
      assert.equal(hasNonAscii('/home/user/project/日本語'), true);
    });

    it('should return original path without junction for ASCII paths', () => {
      const tempDir = os.tmpdir();
      const res = ensureAsciiDirectory(tempDir);
      assert.equal(res.originalPath, path.resolve(tempDir));
      assert.equal(res.isJunction, false);
      res.cleanup();
    });

    it('should throw when target directory does not exist', () => {
      const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
      assert.throws(() => {
        ensureAsciiDirectory(nonExistent);
      }, /Target directory does not exist/);
    });
  });

  describe('Executable cache clearing', () => {
    it('should clear executable cache without error', () => {
      assert.doesNotThrow(() => {
        clearExecutableCache();
      });
    });
  });
});
