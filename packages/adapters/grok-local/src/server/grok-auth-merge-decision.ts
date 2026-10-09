import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// The single identity-and-freshness predicate for the Grok credential
// copy-out lives in `grok-auth-merge-decision.cjs`. It reads only the two
// files and exits with a code; it never prints token bytes. Argument order
// sets source and destination (first = source, second = destination), so the
// caller frames the direction. Exit 10 = use source; exit 20 = keep
// destination; exit 21 = keep destination, an expiry was present but not a
// recognized encoding; exit 22 = keep destination, the source expiry sat
// further ahead of the host clock than the plausible bound. This module
// gives every caller one shared entry point, so the predicate contract can
// never drift between callers.

const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./grok-auth-merge-decision.cjs", import.meta.url),
);

/** Exit code: install the source credential over the destination. */
export const USE_SOURCE_EXIT = 10;
/** Exit code: keep the destination credential. */
export const KEEP_DESTINATION_EXIT = 20;
/** Exit code: keep the destination; an expiry was present but unreadable. */
export const UNREADABLE_EXPIRY_EXIT = 21;
/** Exit code: keep the destination; the source expiry was implausibly far ahead. */
export const IMPLAUSIBLE_EXPIRY_EXIT = 22;

const KNOWN_EXIT_CODES = new Set([
  USE_SOURCE_EXIT,
  KEEP_DESTINATION_EXIT,
  UNREADABLE_EXPIRY_EXIT,
  IMPLAUSIBLE_EXPIRY_EXIT,
]);

export interface DecideGrokAuthMergeOptions {
  /** The caller name that prefixes a predicate error, for example
   *  `grok auth copy-out`. */
  errorLabel: string;
}

/**
 * Runs the shared decision predicate and returns its exit code (10, 20, 21,
 * or 22). Any other exit, or a failure to run `node`, is a hard failure: this
 * throws so a broken predicate is never mistaken for a "keep destination"
 * decision.
 */
export async function decideGrokAuthMerge(
  sourcePath: string,
  destinationPath: string,
  options: DecideGrokAuthMergeOptions,
): Promise<number> {
  try {
    await execFile("node", [DECISION_SCRIPT_PATH, sourcePath, destinationPath]);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && KNOWN_EXIT_CODES.has(code)) {
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
  // `execFile` resolved, so the predicate exited 0. The predicate always
  // exits 10, 20, 21, or 22, so a clean exit 0 is unexpected; fail loud.
  throw new Error(
    `${options.errorLabel} decision predicate exited 0 (expected 10, 20, 21, or 22)`,
  );
}
