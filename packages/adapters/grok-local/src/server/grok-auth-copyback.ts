import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { USE_SOURCE_EXIT, decideGrokAuthMerge } from "./grok-auth-merge-decision.js";

// The copy-out runs the direction-agnostic decision predicate with the
// sandbox credential as the `source` and the shared host credential as the
// `destination`: exit 10 (use source) installs the sandbox copy onto the
// host; every other exit (20, 21, 22) keeps the host copy. The predicate
// only ever reads the two files and exits with a code; it never prints
// token bytes.

/** Outcome of a copy-out attempt. No token material is ever surfaced. */
export type CopyBackGrokAuthOutcome = "copied" | "kept-host";

export interface CopyBackGrokAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-
   * destroyed) sandbox. In production this is bound to the managed-runtime
   * restore context's `readFile` for `${assetDir}/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * The managed Grok home directory to (maybe) update. Callers must resolve
   * this from `resolveManagedGrokHomeDir` — never from a user- or
   * environment-supplied value — so the copy-out destination always stays
   * server-derived.
   */
  hostHomeDir: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log: (line: string) => void | Promise<void>;
  /** Environment for the directory-merge-lock root resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Guards, locks, and atomically installs a strictly-later same-identity
 * sandbox Grok `auth.json` onto the shared host credential at teardown.
 *
 * Sequence, all under `withDirectoryMergeLock` on `hostHomeDir` so a
 * concurrent copy-out can never interleave with another:
 *   1. Read the sandbox credential bytes. A genuinely absent sandbox
 *      `auth.json` (ENOENT) means there is nothing to copy back, so this
 *      resolves to `kept-host` (benign no-op, host untouched); every other
 *      read error stays fail-loud.
 *   2. Stage the bytes to a `0600` temp file inside `hostHomeDir`, which
 *      doubles as the predicate `source`.
 *   3. Run the decision predicate (`source` = staged temp, `destination` =
 *      the host `auth.json`, which may not exist yet). Exit 10 installs the
 *      sandbox copy; every other exit keeps the host copy untouched
 *      (including a wholly absent one).
 *   4. On install, `rename` the staged temp over the host `auth.json` — an
 *      atomic same-directory swap that preserves mode `0600`.
 * The staged temp is always removed (the rename consumes it on the install
 * path; the `finally` removes it otherwise), so no failure ever leaves a
 * temporary file, and the displaced host credential is never kept as a
 * backup anywhere. Never logs token bytes. On error, only the `errno` code
 * is logged, then the error is rethrown — the message would embed the home
 * path, and the path embeds the account handle.
 */
export async function copyBackGrokAuth(input: CopyBackGrokAuthInput): Promise<CopyBackGrokAuthOutcome> {
  const { readSandboxAuth, hostHomeDir, log, env } = input;

  // Read first (outside the lock) — a read never mutates the host, so there
  // is nothing to serialize yet. A genuinely absent sandbox `auth.json`
  // (ENOENT — a non-provisioned edge, or Grok removed it mid-run) is a
  // "nothing to copy back" no-op, not a teardown failure. Every other read
  // error stays fail-loud so a real read fault is never silently mistaken
  // for "nothing to copy back".
  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await log(
        "[paperclip] Grok auth copy-out: no sandbox credential to copy back (absent auth.json); host credential kept.",
      );
      return "kept-host";
    }
    throw error;
  }

  try {
    await mkdir(hostHomeDir, { recursive: true });
    return await withDirectoryMergeLock(
      hostHomeDir,
      async (canonicalHostHomeDir) => {
        const hostAuthPath = path.join(canonicalHostHomeDir, "auth.json");
        // Stage on the same filesystem as the host target so both the
        // predicate read and the final rename stay device-local (rename
        // across devices is not atomic and would fail with EXDEV).
        const stagedTempPath = path.join(
          canonicalHostHomeDir,
          `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`,
        );
        // `wx` + explicit mode create the temp private (0600) and fail if it
        // somehow already exists, so this never writes through a
        // pre-existing symlink.
        const handle = await open(stagedTempPath, "wx", 0o600);
        try {
          await handle.writeFile(sandboxAuthBytes);
          await handle.close();

          const decision = await decideGrokAuthMerge(stagedTempPath, hostAuthPath, {
            errorLabel: "grok auth copy-out",
          });
          if (decision === USE_SOURCE_EXIT) {
            // Atomic same-directory swap; rename preserves the temp's 0600 mode.
            await rename(stagedTempPath, hostAuthPath);
            await log(
              "[paperclip] Grok auth copy-out: sandbox credential is strictly newer for the same identity; installed to the host at mode 0600.",
            );
            return "copied";
          }

          await log(
            "[paperclip] Grok auth copy-out: host credential kept (sandbox copy is not a strictly-newer same-identity credential).",
          );
          return "kept-host";
        } finally {
          // The temp is the thing that must never linger. On the install
          // path rename already consumed it (force makes the removal a
          // no-op); on every other path this deletes the staged bytes.
          await handle.close().catch(() => undefined);
          await rm(stagedTempPath, { force: true }).catch(() => undefined);
        }
      },
      env,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    await Promise.resolve(
      log(`[paperclip] Grok auth copy-out failed (${code}); host credential kept.`),
    ).catch(() => undefined);
    throw error;
  }
}
