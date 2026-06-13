import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";

/**
 * On Windows the `npm` executable is a `.cmd` shim. Since the Node.js fix for
 * CVE-2024-27980 ("BatBadBut"), `child_process.execFile` refuses to spawn a
 * `.bat`/`.cmd` file with `EINVAL` unless `shell: true` is set — so on Windows
 * npm must be invoked through a shell. A shell re-parses its command line, so
 * to keep the long-standing "no shell injection from package name/version"
 * guarantee we (a) reject arguments containing characters that stay dangerous
 * inside a double-quoted `cmd.exe` string and (b) wrap every non-flag argument
 * in double quotes. On non-Windows platforms we keep using `execFile` with an
 * argument vector and no shell, which is injection-safe by construction.
 */

/**
 * Reject characters that remain dangerous inside a double-quoted `cmd.exe`
 * argument: `%` (environment-variable expansion), `"` (ends the quoted span),
 * and control characters (can smuggle in additional commands). Spaces and
 * shell metacharacters such as `^ & | < >` are inert once double-quoted.
 */
function assertSafeWindowsArg(arg: string): void {
  for (const ch of arg) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "%" || code < 0x20 || code === 0x7f) {
      throw new Error(`Unsafe npm argument rejected: ${JSON.stringify(arg)}`);
    }
  }
}

/**
 * Build the `cmd.exe` command line used to invoke `npm.cmd` on Windows.
 * Flags (arguments starting with `-`) pass through verbatim; every other
 * argument is validated and double-quoted so package specs and paths cannot
 * inject additional shell commands.
 */
function buildWindowsCommandLine(args: string[]): string {
  return ["npm.cmd"]
    .concat(
      args.map((arg) => {
        if (arg.startsWith("-")) return arg;
        assertSafeWindowsArg(arg);
        return `"${arg}"`;
      }),
    )
    .join(" ");
}

export interface RunNpmOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Run an `npm` subcommand cross-platform.
 *
 * `args` is the full npm argument vector (e.g. `["install", spec, "--save"]`).
 * Flags (arguments starting with `-`) are assumed to be code-controlled
 * literals; any other argument (package specs, paths) is treated as untrusted
 * and validated/quoted before reaching a shell on Windows.
 */
export async function runNpm(args: string[], options: RunNpmOptions = {}) {
  if (!isWindows) {
    return execFileAsync("npm", args, options);
  }

  return execFileAsync(buildWindowsCommandLine(args), [], { ...options, shell: true });
}

// Exported for unit testing only.
export const __test__ = { assertSafeWindowsArg, buildWindowsCommandLine, isWindows };
