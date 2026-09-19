import fs from "node:fs/promises";

/**
 * Session records and Codex homes hold run state that has carried live
 * credentials (KEE-188, KEE-192). Node creates files at `0666 & ~umask` and
 * directories at `0777 & ~umask` — `0644` / `0755` under the usual `022` — so
 * anything written without an explicit mode is world-readable.
 *
 * This module sets the mode **at creation**. A create-then-`chmod` leaves a
 * window where the file is readable by every account on the host, and KEE-193
 * measured that a periodic `chmod` sweep cannot hold at all: 13 files were back
 * at `0644` within hours, 6 of them inside four minutes, because every run
 * re-creates them.
 *
 * Read this as **narrowing, not a control that works**. Every Paperclip agent
 * seat on a single-host install runs as the same OS account, so `0600` keeps
 * these files from other OS users and from nothing else. A seat can still read
 * another seat's files. The shared-account problem is untouched by this module;
 * keeping credential values out of the file (KEE-192) is the control that does
 * work.
 */
export const RESTRICTED_DIR_MODE = 0o700;
export const RESTRICTED_FILE_MODE = 0o600;

/** Bits this module exists to keep clear: group and other, read/write/execute. */
const GROUP_AND_OTHER = 0o077;

/**
 * Create `dir` at `0700`, and narrow it if a previous version of Paperclip (or
 * a dependency) already created it wider.
 *
 * The repair half is not a sweep. A directory is created once and then persists,
 * so narrowing an existing one converges on the first run and is a no-op on
 * every run after — unlike the files inside it, which are rewritten constantly
 * and are exactly why a scheduled `chmod` was rejected.
 *
 * Returns run-log lines: empty when the directory was already private.
 */
export async function ensureRestrictedDir(dir: string): Promise<string[]> {
  try {
    // `recursive` applies the mode to each directory this call creates, so an
    // absent parent is not left at 0755 with a 0700 child inside it.
    await fs.mkdir(dir, { recursive: true, mode: RESTRICTED_DIR_MODE });
  } catch (err) {
    return [`[paperclip] Could not create "${dir}" privately: ${errorText(err)}`];
  }

  // `mode` is masked by the process umask and is ignored outright when the
  // directory already exists, so read back what is actually on disk rather than
  // trusting the argument.
  let mode: number;
  try {
    mode = (await fs.stat(dir)).mode & 0o777;
  } catch (err) {
    return [`[paperclip] Could not read the mode of "${dir}": ${errorText(err)}`];
  }
  if ((mode & GROUP_AND_OTHER) === 0) return [];

  try {
    await fs.chmod(dir, RESTRICTED_DIR_MODE);
  } catch (err) {
    return [
      `[paperclip] "${dir}" is mode ${formatMode(mode)} and could not be narrowed to 0700: ` +
        `${errorText(err)}. Files under it are readable by other accounts on this host.`,
    ];
  }
  return [
    `[paperclip] Narrowed "${dir}" from mode ${formatMode(mode)} to 0700 ` +
      "(it holds run state that has carried credentials).",
  ];
}

/**
 * Write `text` to `filePath` at `0600`, created at that mode rather than
 * chmod-ed into it.
 *
 * `fs.writeFile`'s `mode` only applies when the call creates the file: an
 * existing path is truncated and keeps whatever mode it already had. Removing
 * the path first is what makes the mode argument mean something. Callers write
 * to a temporary path and `rename()` it into place, so the removal never races
 * a reader of the real file.
 */
export async function writeRestrictedFile(filePath: string, text: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await fs.writeFile(filePath, text, { encoding: "utf8", mode: RESTRICTED_FILE_MODE });
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
