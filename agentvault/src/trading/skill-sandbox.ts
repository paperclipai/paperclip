/**
 * Skill Sandbox
 *
 * Enforces isolation constraints when executing OpenClaw / Clawdbot skills:
 *
 *   1. **No root** — the process must NOT run as uid 0 (root).
 *   2. **Write confinement** — file writes are only permitted under /tmp.
 *      Any attempt to write outside /tmp is blocked with an explicit error.
 *
 * Threat model: assume the skill code (an untrusted, domain-specific script
 * loaded at runtime) could be compromised.  The sandbox prevents privilege
 * escalation and permanent host mutation beyond the ephemeral /tmp scratch
 * space.
 *
 * Usage:
 *   const sandbox = new SkillSandbox();
 *   sandbox.assertSafe();                      // throws if uid=0
 *   sandbox.assertWritePath('/tmp/output.txt'); // throws if outside /tmp
 *   const safeFn = sandbox.wrapWrite(fs.writeFileSync);
 */

import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only directory tree in which skill file-writes are permitted. */
export const SKILL_WRITE_ROOT = '/tmp';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxViolation {
  type: 'root-process' | 'write-outside-tmp' | 'absolute-path-required';
  message: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the effective uid of the current process.
 * On Windows this is always -1 (Windows does not have POSIX uids;
 * skills should still be allowed to run there without triggering this check).
 */
function getEffectiveUid(): number {
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }
  // Windows / non-POSIX — no uid concept.
  return -1;
}

/**
 * Resolve `filePath` to an absolute path and verify it is under `root`.
 * Uses `path.resolve` so relative paths and `..` components are handled
 * before the containment check.
 */
function isUnderRoot(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  // Ensure we compare with a trailing separator to avoid "/tmpfoo" matching "/tmp".
  const normalRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(normalRoot);
}

// ---------------------------------------------------------------------------
// SkillSandbox
// ---------------------------------------------------------------------------

export class SkillSandbox {
  private readonly writeRoot: string;

  /**
   * @param writeRoot   The only directory tree skills may write to.
   *                    Defaults to `/tmp` (or `os.tmpdir()` on non-Linux).
   */
  constructor(writeRoot?: string) {
    // On Linux, always use /tmp.  On other platforms use the OS temp dir.
    this.writeRoot = writeRoot ?? (os.platform() === 'linux' ? SKILL_WRITE_ROOT : os.tmpdir());
  }

  // ── Root check ────────────────────────────────────────────────────────────

  /**
   * Throw if the process is running as root (uid 0).
   *
   * Root execution is prohibited for skills because a compromised skill
   * running as root can bypass every other OS-level control.
   */
  assertNotRoot(): void {
    const uid = getEffectiveUid();
    if (uid === 0) {
      throw Object.assign(
        new Error(
          'SkillSandbox: skill execution is forbidden under the root (uid 0) account. ' +
          'Re-run the agent as a non-privileged user.',
        ),
        { sandboxViolation: { type: 'root-process', message: 'uid is 0' } as SandboxViolation },
      );
    }
  }

  // ── Write path check ──────────────────────────────────────────────────────

  /**
   * Throw if `filePath` resolves to a location outside the allowed write root.
   *
   * This is the central enforcement point.  Wrap every `fs.writeFile`,
   * `fs.writeFileSync`, `fs.open`, etc. call with this check.
   */
  assertWritePath(filePath: string): void {
    if (!path.isAbsolute(path.resolve(filePath))) {
      // Should never happen — path.resolve always returns absolute — but be
      // defensive.
      throw Object.assign(
        new Error(`SkillSandbox: could not resolve path "${filePath}" to an absolute path.`),
        {
          sandboxViolation: {
            type: 'absolute-path-required',
            message: `Path could not be resolved: ${filePath}`,
          } as SandboxViolation,
        },
      );
    }

    if (!isUnderRoot(filePath, this.writeRoot)) {
      const resolved = path.resolve(filePath);
      throw Object.assign(
        new Error(
          `SkillSandbox: write to "${resolved}" is blocked. ` +
          `Skills may only write inside ${this.writeRoot}. ` +
          'Move the output path to a location under that directory.',
        ),
        {
          sandboxViolation: {
            type: 'write-outside-tmp',
            message: `Attempted write to ${resolved}`,
            detail: `Allowed root: ${this.writeRoot}`,
          } as SandboxViolation,
        },
      );
    }
  }

  // ── Combined safety assertion ─────────────────────────────────────────────

  /**
   * Run all pre-execution safety checks.  Call this once at skill load time
   * before any skill code runs.
   */
  assertSafe(): void {
    this.assertNotRoot();
  }

  // ── Write wrappers ────────────────────────────────────────────────────────

  /**
   * Wrap `fs.writeFileSync` (or any function whose first argument is a file
   * path) so that the path check is applied automatically.
   *
   * Example:
   *   import * as fs from 'node:fs';
   *   const safeWrite = sandbox.wrapWrite(fs.writeFileSync.bind(fs));
   *   safeWrite('/tmp/output.txt', data);          // OK
   *   safeWrite('/etc/cron.d/evil', payload);      // throws
   */
  wrapWrite<Args extends unknown[], R>(
    fn: (filePath: string, ...rest: Args) => R,
  ): (filePath: string, ...rest: Args) => R {
    return (filePath: string, ...rest: Args): R => {
      this.assertWritePath(filePath);
      return fn(filePath, ...rest);
    };
  }

  /**
   * Wrap an async write function (e.g. `fs.promises.writeFile`).
   */
  wrapWriteAsync<Args extends unknown[], R>(
    fn: (filePath: string, ...rest: Args) => Promise<R>,
  ): (filePath: string, ...rest: Args) => Promise<R> {
    return async (filePath: string, ...rest: Args): Promise<R> => {
      this.assertWritePath(filePath);
      return fn(filePath, ...rest);
    };
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Return the current write-root this sandbox enforces. */
  getWriteRoot(): string {
    return this.writeRoot;
  }

  /** Return true if the process uid check would pass (not root). */
  isRunningAsRoot(): boolean {
    return getEffectiveUid() === 0;
  }

  /**
   * Return a summary of the sandbox configuration suitable for logging.
   * Never includes sensitive information.
   */
  describe(): { uid: number; writeRoot: string; isRoot: boolean } {
    return {
      uid: getEffectiveUid(),
      writeRoot: this.writeRoot,
      isRoot: this.isRunningAsRoot(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (convenience export)
// ---------------------------------------------------------------------------

/**
 * A default SkillSandbox instance using the standard /tmp write root.
 * Import this directly if you don't need custom configuration.
 */
export const defaultSandbox = new SkillSandbox();
