import { execFile as execFileCallback } from "node:child_process";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";

const execFile = promisify(execFileCallback);

// The outbound copy-back reuses the exact same direction-agnostic decision
// predicate the inbound restore runs (`codex-auth-merge-decision.cjs`). The
// predicate answers one question — "should the caller replace `destination`
// with `source`?" — purely by argument order (first = source, second =
// destination). For the copy-back the sandbox credential is the `source` and
// the shared host credential is the `destination`, so exit 10 (use source)
// means "install the sandbox copy onto the host" and exit 20 (keep destination)
// means "leave the host copy untouched". The predicate only ever reads the two
// files and exits with a code; it never prints token bytes.
const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./codex-auth-merge-decision.cjs", import.meta.url),
);
const USE_SOURCE_EXIT = 10;
const KEEP_DESTINATION_EXIT = 20;

/** Outcome of a copy-back attempt. No token material is ever surfaced. */
export type CopyBackCodexAuthOutcome = "copied" | "kept-host";

export interface CopyBackCodexAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-destroyed)
   * sandbox. In production this is bound to the managed-runtime restore
   * context's `readFile` for `${assetDir}/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * Absolute path of the shared host credential to (maybe) overwrite — the
   * symlink *source* the managed Codex homes point their `auth.json` at, never
   * an in-sandbox or per-agent symlink.
   */
  hostAuthPath: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log: (line: string) => void | Promise<void>;
}

async function decideExitCode(sourcePath: string, destinationPath: string): Promise<number> {
  try {
    await execFile("node", [DECISION_SCRIPT_PATH, sourcePath, destinationPath]);
    // The predicate always exits 10 or 20; a clean exit 0 is unexpected and is
    // treated as a failure rather than silently interpreted as a decision.
    throw new Error("codex auth copy-back decision predicate exited 0 (expected 10 or 20)");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === USE_SOURCE_EXIT || code === KEEP_DESTINATION_EXIT) {
      return code;
    }
    // A non-numeric `code` (e.g. "ENOENT" when node is not on PATH) or any exit
    // code other than 10/20 is a hard failure — fail loud so a broken predicate
    // is never mistaken for a "keep host" decision.
    const detail =
      typeof code === "string"
        ? `node could not be executed (${code})`
        : typeof code === "number"
        ? `unexpected predicate exit code ${code}`
        : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`codex auth copy-back decision predicate failed: ${detail}`);
  }
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Codex
 * `auth.json` onto the shared host credential at teardown.
 *
 * Sequence, all under `withDirectoryMergeLock` on the host target's directory
 * so a concurrent inbound restore or another copy-back can't interleave:
 *   1. Read the sandbox credential bytes (fail loud on read error).
 *   2. Stage them to a `0600` temp file on the **same filesystem** as the host
 *      target (its directory), which doubles as the predicate `source`.
 *   3. Run the Phase-3 decision predicate (`source` = sandbox temp, `destination`
 *      = host). Exit 10 → adopt the sandbox copy; exit 20 → keep the host copy.
 *   4. On exit 10, `rename` the staged temp over the host target — an atomic
 *      same-directory swap that preserves mode `0600`. On exit 20, discard it.
 * The staged temp is always removed (rename consumes it on the copy path; the
 * finally cleans it up otherwise), so a failure never leaves a partial file.
 * Never logs token bytes — only the decision outcome.
 */
export async function copyBackCodexAuth(input: CopyBackCodexAuthInput): Promise<CopyBackCodexAuthOutcome> {
  const { readSandboxAuth, hostAuthPath, log } = input;

  // Read first (outside the lock) — a read failure is fail-loud and never
  // mutates the host, so there is nothing to serialize yet.
  const sandboxAuthBytes = await readSandboxAuth();

  const hostDir = path.dirname(hostAuthPath);
  return withDirectoryMergeLock(hostDir, async () => {
    // Stage on the same filesystem as the host target so both the predicate read
    // and the final rename stay device-local (rename across devices is not
    // atomic and would fail with EXDEV).
    const stagedTempPath = path.join(hostDir, `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`);
    // `wx` + explicit mode create the temp private (0600) and fail if it somehow
    // already exists, so we never write through a pre-existing symlink.
    const handle = await open(stagedTempPath, "wx", 0o600);
    try {
      await handle.writeFile(sandboxAuthBytes);
      await handle.close();

      const decision = await decideExitCode(stagedTempPath, hostAuthPath);
      if (decision === USE_SOURCE_EXIT) {
        // Atomic same-directory swap; rename preserves the temp's 0600 mode.
        await rename(stagedTempPath, hostAuthPath);
        await log(
          "[paperclip] Codex auth copy-back: sandbox credential is strictly newer for the same subscription identity; installed to the host at mode 0600.",
        );
        return "copied";
      }

      await log(
        "[paperclip] Codex auth copy-back: host credential kept (sandbox copy is not a strictly-newer same-identity subscription credential).",
      );
      return "kept-host";
    } finally {
      // Close is idempotent-safe to skip after an explicit close; the temp is the
      // thing that must never linger. On the copy path rename already consumed it
      // (force makes the removal a no-op); on every other path this deletes the
      // staged credential bytes.
      await handle.close().catch(() => undefined);
      await rm(stagedTempPath, { force: true }).catch(() => undefined);
    }
  });
}
