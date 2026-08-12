import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// The single identity-and-freshness predicate. Every credential writer that must
// answer "should the caller replace `destination` with `source`?" runs this one
// predicate: the inbound restore, the outbound copy-back, the per-identity cache
// slot, and the device-login promotion. The predicate lives in
// `codex-auth-merge-decision.cjs`. It reads only the two files, and it exits with
// a code; it never prints token bytes. Argument order sets source and
// destination (first = source, second = destination), so the caller frames the
// direction. Exit 10 = use source; exit 20 = keep destination. The leading
// `--seed-if-dest-absent` flag adds one behavior: fill an absent destination slot
// from a usable subscription source. This module gives every caller one shared
// entry point, so the predicate contract can never drift between callers.

const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./codex-auth-merge-decision.cjs", import.meta.url),
);
const SEED_IF_DEST_ABSENT_FLAG = "--seed-if-dest-absent";

/** Exit code: install the source credential over the destination. */
export const USE_SOURCE_EXIT = 10;
/** Exit code: keep the destination credential. */
export const KEEP_DESTINATION_EXIT = 20;

export interface DecideCodexAuthMergeOptions {
  /** Opt in to the cache-slot seed mode: fill an absent destination from a
   *  usable subscription source. */
  seedIfDestAbsent?: boolean;
  /** The caller name that prefixes a predicate error, for example
   *  `codex auth cache`. */
  errorLabel: string;
}

/**
 * Runs the shared decision predicate and returns its exit code (10 or 20). A
 * non-10/20 exit, or a failure to run `node`, is a hard failure: this throws so a
 * broken predicate is never mistaken for a "keep destination" decision.
 */
export async function decideCodexAuthMerge(
  sourcePath: string,
  destinationPath: string,
  options: DecideCodexAuthMergeOptions,
): Promise<number> {
  const args = options.seedIfDestAbsent
    ? [DECISION_SCRIPT_PATH, SEED_IF_DEST_ABSENT_FLAG, sourcePath, destinationPath]
    : [DECISION_SCRIPT_PATH, sourcePath, destinationPath];
  try {
    await execFile("node", args);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === USE_SOURCE_EXIT || code === KEEP_DESTINATION_EXIT) {
      return code;
    }
    const detail =
      typeof code === "string"
        ? `node could not be executed (${code})`
        : typeof code === "number"
          ? `unexpected predicate exit code ${code}`
          : error instanceof Error
            ? error.message
            : String(error);
    throw new Error(`${options.errorLabel} decision predicate failed: ${detail}`);
  }
  // `execFile` resolved, so the predicate exited 0. The predicate always exits 10
  // or 20, so a clean exit 0 is unexpected; fail loud.
  throw new Error(
    `${options.errorLabel} decision predicate exited 0 (expected 10 or 20)`,
  );
}
