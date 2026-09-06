import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { USE_SOURCE_EXIT, decideCodexAuthMerge } from "./codex-auth-merge-decision.js";

// The one atomic credential writer. It stages the source bytes into a private
// (0600) temp next to the destination, runs the shared decision predicate, and
// on a use-source decision renames the temp over the destination. The rename is
// an atomic same-directory swap that preserves mode 0600. The whole write runs
// under the directory merge lock, so a concurrent restore, copy-back, or
// promotion can never interleave. The per-identity cache slot and the
// device-login company home both use this writer, so the staged-rename and lock
// logic lives in one place. It never logs token bytes; the caller passes the
// fixed status lines.

export type WriteCredentialSeedOrNewerOutcome = "written" | "kept";

export interface WriteCredentialSeedOrNewerInput {
  /** The source credential bytes to (maybe) install. */
  sourceBytes: Buffer;
  /** The absolute destination path to (maybe) overwrite. */
  destinationPath: string;
  /** Fill an absent destination from a usable subscription source. */
  seedIfDestAbsent: boolean;
  /** A non-leaking progress sink. It receives only the two fixed status lines. */
  log: (line: string) => void | Promise<void>;
  /** The fixed status line for a use-source write. It carries no secret data. */
  writtenLine: string;
  /** The fixed status line for a keep-destination decision. */
  keptLine: string;
  /** A safe, non-secret prefix for the staged temp file name. */
  tempPrefix: string;
  /** The caller name that prefixes a predicate error. */
  errorLabel: string;
  /** Environment for the merge lock root. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Writes `sourceBytes` over `destinationPath` when the shared predicate returns a
 * use-source decision, else keeps the destination. Seeds an absent destination
 * only when `seedIfDestAbsent` is set and the source is a usable subscription
 * credential. The staged temp is always removed, so a failure never leaves a
 * partial file.
 */
export async function writeCredentialSeedOrNewer(
  input: WriteCredentialSeedOrNewerInput,
): Promise<WriteCredentialSeedOrNewerOutcome> {
  const destinationDir = path.dirname(input.destinationPath);
  return withDirectoryMergeLock(
    destinationDir,
    async () => {
      const stagedTempPath = path.join(
        destinationDir,
        `.${input.tempPrefix}-${process.pid}-${randomUUID()}.tmp`,
      );
      // `wx` + explicit mode create the temp private (0600) and fail if it already
      // exists, so the writer never writes through a pre-existing symlink.
      const handle = await open(stagedTempPath, "wx", 0o600);
      try {
        await handle.writeFile(input.sourceBytes);
        await handle.close();
        const decision = await decideCodexAuthMerge(stagedTempPath, input.destinationPath, {
          seedIfDestAbsent: input.seedIfDestAbsent,
          errorLabel: input.errorLabel,
        });
        if (decision === USE_SOURCE_EXIT) {
          await rename(stagedTempPath, input.destinationPath);
          await input.log(input.writtenLine);
          return "written";
        }
        await input.log(input.keptLine);
        return "kept";
      } finally {
        await handle.close().catch(() => undefined);
        await rm(stagedTempPath, { force: true }).catch(() => undefined);
      }
    },
    input.env,
  );
}
