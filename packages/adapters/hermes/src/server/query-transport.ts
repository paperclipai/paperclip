/**
 * Query transport for `hermes chat`, kept in one place so the argv layout is
 * validated instead of assembled ad hoc.
 *
 * The CLI's parser is strict about where the query sits. Its own usage line is:
 *
 *   usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] ...
 *
 * and `-q` and `--query-file` are mutually exclusive. A `--query-file` appended
 * at the end of the argv (after `--yolo`, or after an operator `--` separator)
 * is read as positional text, or rejected outright, and the run never starts.
 * Both transports are therefore only ever accepted in the query slot, and the
 * argv is asserted before it is handed to `spawn()`.
 */

/**
 * Largest query the adapter passes as a single argv entry.
 *
 * `MAX_ARG_STRLEN` is `32 * PAGE_SIZE`, so 131072 bytes on a 4 KiB-page kernel.
 * Measured on Linux 7.2.x / PAGE_SIZE 4096: 131071 bytes start, 131072 bytes
 * fail with `E2BIG`. This is a compile-time kernel constant, not a sysctl:
 * `RLIMIT_STACK` moves the total argv+env budget, never the per-string cap.
 *
 * Linux is the only platform that caps one argv entry, so this is the inline
 * rule everywhere except Windows, which caps the whole command line instead
 * (see `classifyHermesQueryTransport`).
 */
export const HERMES_MAX_INLINE_QUERY_BYTES = 131072;

/**
 * Largest command line `CreateProcess` accepts on Windows: 32767 UTF-16 units,
 * program name and every argument included. Windows has no per-entry cap, so a
 * query there may stay in `-q` for as long as the complete command line fits.
 */
export const HERMES_MAX_COMMAND_LINE_UNITS_WINDOWS = 32767;

/**
 * Units held back from the Windows command-line budget for the program name,
 * the surrounding quotes, and the backslash escaping the loader adds. The
 * command path is operator-configured and can be long, so the margin is wide.
 */
export const HERMES_WINDOWS_COMMAND_LINE_RESERVE_UNITS = 4096;

/**
 * Overhead reserved for Hermes's Windows `venv_sync.relaunch_command` wrapper
 * (`python -I -c "import sys, runpy; ...; sys.argv = [...]; ..."`), which
 * re-embeds the entire argv via Python `repr()` on a second Windows command line.
 */
export const HERMES_WINDOWS_RELAUNCH_WRAPPER_UNITS = 512;

export type HermesQueryTransportDecision =
  /** Inline `-q <query>` fits safely within the platform command-line rules. */
  | "inline"
  /**
   * Fits `CreateProcess` directly, but Hermes's Windows relaunch step expands
   * `argv` via `repr()` and can push the second launch past 32767 units. Use
   * `--query-file` when supported, without breaking older CLIs that lack it.
   */
  | "prefer-file"
  /** Exceeds the OS launch limit; `--query-file` is mandatory. */
  | "require-file";

/**
 * UTF-16 units the Windows command line spends on `args`, quoting, escaping,
 * and inter-argument spacing included.
 *
 * Every argument is wrapped in quotes and consecutive arguments are separated
 * by a space. A quote or a backslash inside an argument is escaped with a
 * backslash of its own, so such a character costs two units rather than one.
 * The estimate is deliberately conservative: it can only move a query to the
 * file transport slightly earlier, never later than the launch limit.
 */
export function windowsCommandLineUnits(args: readonly string[]): number {
  if (args.length === 0) return 0;
  const argUnits = args.reduce((total, arg) => {
    const escaped = (arg.match(/["\\]/g) ?? []).length;
    return total + arg.length + escaped + 2;
  }, 0);
  return argUnits + (args.length - 1);
}

/**
 * Conservative upper bound in UTF-16 units when Hermes's Windows bootstrapper
 * relaunches itself with `python -I -c "... sys.argv = {argv!r} ..."`.
 *
 * Python `repr()` turns newlines, carriage returns, tabs, and quotes into
 * multi-character escape sequences, and `CreateProcess` then escapes quotes
 * and backslashes inside that `-c` argument a second time.
 */
export function windowsRelaunchCommandLineUnits(args: readonly string[]): number {
  let total = HERMES_WINDOWS_RELAUNCH_WRAPPER_UNITS;
  for (const arg of args) {
    // List element quotes and `, ` separator inside `sys.argv = [...]`.
    total += arg.length + 4;
    for (let i = 0; i < arg.length; i += 1) {
      const code = arg.charCodeAt(i);
      if (code === 0x5c /* \ */) {
        // `repr` doubles `\` to `\\`; if adjacent to `"`, Windows escaping doubles both.
        total += 3;
      } else if (code === 0x22 /* " */) {
        // `repr` + Windows `CreateProcess` backslash escaping.
        total += 2;
      } else if (
        code === 0x27 /* ' */ ||
        code === 0x0a /* \n */ ||
        code === 0x0d /* \r */ ||
        code === 0x09 /* \t */
      ) {
        total += 1;
      } else if (code < 0x20 || code === 0x7f) {
        // `\xNN` expansion (4 units instead of 1).
        total += 3;
      }
    }
  }
  return total;
}

/**
 * Classify how the adapter should pass `query` for the target platform.
 *
 * Non-Windows checks UTF-8 byte length of `query` against `MAX_ARG_STRLEN`
 * (131072 bytes). Windows has no per-entry cap, so it measures the complete
 * command line in UTF-16 units (`args` is required) and distinguishes the hard
 * OS `CreateProcess` limit (`require-file`) from the Hermes Windows relaunch
 * expansion risk (`prefer-file`).
 */
export function classifyHermesQueryTransport(
  query: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): HermesQueryTransportDecision {
  if (platform !== "win32") {
    return Buffer.byteLength(query, "utf8") >= HERMES_MAX_INLINE_QUERY_BYTES
      ? "require-file"
      : "inline";
  }
  if (args.length === 0) {
    throw new Error(
      "[hermes] The Windows inline check needs the complete command line, not the query alone.",
    );
  }
  if (
    windowsCommandLineUnits(args) + HERMES_WINDOWS_COMMAND_LINE_RESERVE_UNITS >=
    HERMES_MAX_COMMAND_LINE_UNITS_WINDOWS
  ) {
    return "require-file";
  }
  if (
    windowsRelaunchCommandLineUnits(args) + HERMES_WINDOWS_COMMAND_LINE_RESERVE_UNITS >=
    HERMES_MAX_COMMAND_LINE_UNITS_WINDOWS
  ) {
    return "prefer-file";
  }
  return "inline";
}

/**
 * True when the query exceeds the OS inline launch limit of `args`.
 */
export function queryExceedsInlineLimit(
  query: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return classifyHermesQueryTransport(query, args, platform) === "require-file";
}

/** Query flags the CLI accepts, in the mutually exclusive query slot. */
export const HERMES_INLINE_QUERY_FLAGS = ["-q", "--query"] as const;
export const HERMES_QUERY_FILE_FLAG = "--query-file";

function isInlineQueryFlag(token: string | undefined): boolean {
  return token === "-q" || token === "--query";
}

function isQueryTransportToken(token: string | undefined): boolean {
  if (!token) return false;
  return (
    isInlineQueryFlag(token) ||
    token === HERMES_QUERY_FILE_FLAG ||
    token.startsWith("--query=") ||
    token.startsWith(`${HERMES_QUERY_FILE_FLAG}=`)
  );
}

/**
 * Move the query out of argv.
 *
 * Replaces the inline `-q <query>` entry with `--query-file <path>`. The
 * replacement is positional, not a `push()`: the query flag must stay in the
 * slot the CLI's parser expects. Throws rather than mangling an argv it does
 * not recognise, so a future refactor of the argument builder fails loudly
 * here instead of silently producing a command line `hermes chat` rejects.
 */
export function applyQueryFileTransport(
  args: readonly string[],
  queryFilePath: string,
): string[] {
  if (args[0] !== "chat") {
    throw new Error(
      `[hermes] Cannot move the query out of argv: expected the "chat" subcommand at argv[0], got ${JSON.stringify(args[0])}.`,
    );
  }
  if (!isInlineQueryFlag(args[1])) {
    throw new Error(
      `[hermes] Cannot move the query out of argv: expected an inline query flag at argv[1], got ${JSON.stringify(args[1])}.`,
    );
  }
  if (typeof args[2] !== "string" || args[2].length === 0) {
    throw new Error(
      "[hermes] Cannot move the query out of argv: the inline query flag has no value at argv[2].",
    );
  }
  if (typeof queryFilePath !== "string" || queryFilePath.length === 0) {
    throw new Error("[hermes] Cannot move the query out of argv: no query file path was provided.");
  }

  const next = [...args];
  next.splice(1, 2, HERMES_QUERY_FILE_FLAG, queryFilePath);
  return next;
}

/**
 * Assert the argv still matches what `hermes chat` parses.
 *
 * Called on every run, right before `spawn()`, and covered by tests for the
 * mis-placements that break the CLI. The rules are:
 *
 *  - `chat` is the subcommand at argv[0];
 *  - exactly one query transport sits in the query slot (argv[1]) with a
 *    non-empty value at argv[2];
 *  - a `--query-file` value is a path, never another flag (`-` is the CLI's
 *    stdin sentinel and is allowed);
 *  - no second query transport appears later in the argv;
 *  - the query slot is not hidden behind an operator `--` separator.
 */
export function assertHermesChatQueryTransport(args: readonly string[]): void {
  if (args.length < 3) {
    throw new Error(
      `[hermes] Refusing to start: "hermes chat" needs a query transport and a value, got ${args.length} argv entries.`,
    );
  }
  if (args[0] !== "chat") {
    throw new Error(
      `[hermes] Refusing to start: expected the "chat" subcommand at argv[0], got ${JSON.stringify(args[0])}.`,
    );
  }

  const flag = args[1];
  const value = args[2];
  const inlineFlag = isInlineQueryFlag(flag);
  const fileFlag = flag === HERMES_QUERY_FILE_FLAG;

  if (!inlineFlag && !fileFlag) {
    throw new Error(
      `[hermes] Refusing to start: expected ${HERMES_INLINE_QUERY_FLAGS.join("/")} or ${HERMES_QUERY_FILE_FLAG} in the query slot (argv[1]), got ${JSON.stringify(flag)}.`,
    );
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `[hermes] Refusing to start: ${String(flag)} has no value at argv[2].`,
    );
  }
  // Only `--query-file` rejects flag-like strings (other than `-` for stdin);
  // inline `-q` accepts Markdown prompts starting with `- ` or `---`.
  if (fileFlag && value.startsWith("-") && value !== "-") {
    throw new Error(
      `[hermes] Refusing to start: ${String(flag)} at argv[1] is followed by what looks like another flag (${JSON.stringify(value)}).`,
    );
  }

  for (let index = 3; index < args.length; index += 1) {
    const token = args[index];
    if (isQueryTransportToken(token)) {
      throw new Error(
        `[hermes] Refusing to start: a second query transport (${token}) appears at argv[${index}]; the CLI accepts one and treats the rest as positional text.`,
      );
    }
  }
}
