import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./muse-auth-merge-decision.cjs", import.meta.url),
);

/** Exit code: install the source credential over the destination. */
export const USE_SOURCE_EXIT = 10;
/** Exit code: keep the destination credential. */
export const KEEP_DESTINATION_EXIT = 20;
/** Exit code: keep the destination; an expiry or timestamp was present but unreadable. */
export const UNREADABLE_EXPIRY_EXIT = 21;
/** Exit code: keep the destination; the source timestamp was implausibly far ahead. */
export const IMPLAUSIBLE_EXPIRY_EXIT = 22;

const KNOWN_EXIT_CODES = new Set([
  USE_SOURCE_EXIT,
  KEEP_DESTINATION_EXIT,
  UNREADABLE_EXPIRY_EXIT,
  IMPLAUSIBLE_EXPIRY_EXIT,
]);

export interface DecideMuseAuthMergeOptions {
  /** The caller name that prefixes a predicate error, for example `muse auth copy-back`. */
  errorLabel: string;
}

/**
 * Runs the shared decision predicate and returns its exit code (10, 20, 21, or 22).
 * Any other exit, or failure to execute node, is treated as a hard failure.
 */
export async function decideMuseAuthMerge(
  sourcePath: string,
  destinationPath: string,
  options: DecideMuseAuthMergeOptions,
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
  throw new Error(
    `${options.errorLabel} decision predicate exited 0 (expected 10, 20, 21, or 22)`,
  );
}
