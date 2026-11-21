/**
 * Capability probing for the Hermes Agent CLI.
 *
 * `hermes chat` accepts its query either as one argv string
 * (`-q/--query <text>`) or as a file (`--query-file <path>`), and the two are
 * mutually exclusive in the CLI's own argparse definition:
 *
 *   usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] ...
 *     --query-file PATH  Read the single query from a file instead of the
 *                        command line ('-' reads stdin). Safe for arbitrary
 *                        query sizes. Mutually exclusive with -q.
 *
 * A query passed with `-q` occupies exactly one argv entry, and Linux caps a
 * single argv entry at `MAX_ARG_STRLEN` (131072 bytes = 32 x PAGE_SIZE),
 * independently of the much larger total `ARG_MAX` budget. Once the rendered
 * wake prompt plus the agent instructions cross that size, `spawn()` fails with
 * `E2BIG` and the agent never starts.
 *
 * The flag is probed rather than assumed: a version floor cannot be used,
 * because an operator may point `hermesCommand` at a wrapper, a fork, or a
 * vendored copy. The only reliable signal is whether that binary advertises the
 * flag in its own `chat --help` output.
 */

import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

const execFileAsync = promisify(execFile);
const MAX_PROBE_OUTPUT_CHARS = 64 * 1024;
const PROBE_STOP_GRACE_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;

export type HermesQueryFileProbeResult =
  /** The help text advertised `--query-file`. */
  | true
  /** Help printed and exited zero, and the flag is absent. */
  | false
  /**
   * The probe reached no conclusion: cancelled, timed out, could not spawn the
   * binary, or exited non-zero without printing usage. This is deliberately not
   * a boolean — treating it as "no support" would report a cause that has
   * nothing to do with the real failure, and that wrong cause would end up in
   * the run's error message.
   */
  | null;

export interface HermesQueryFileProbeInput {
  /** Resolved Hermes command (already includes any configured override). */
  command: string;
  cwd: string;
  /** Launch environment, so a command resolved through `PATH` is found. */
  env: Record<string, string>;
  /** Probe budget; clamped to [1s, 60s]. */
  timeoutMs?: number;
  /** Run-scoped operator cancellation, when the host provides one. */
  signal?: AbortSignal;
}

/**
 * Match `--query-file` as CLI usage/help output formats it (`--query-file PATH`,
 * `--query-file=PATH`, `[--query-file ...]`, `| --query-file`), avoiding false
 * positives from prose like `"query file"` or negated flags like `--no-query-file`.
 */
export function hasQueryFileFlagInHelp(helpText: string): boolean {
  return /(?:^|[\s\[(|])--query-file(?:[\s=,\])|]|$)/.test(helpText);
}

/**
 * Build a sanitized launch environment for `--help` probing.
 *
 * Strips `HERMES_EPHEMERAL_SYSTEM_PROMPT` (which can be large enough to trigger
 * `E2BIG` before `--help` starts) and `PAPERCLIP_API_KEY` (unnecessary secret
 * exposure for a capability check).
 */
export function buildProbeEnv(env: Record<string, string>): Record<string, string> {
  const probeEnv = ensurePathInEnv({ ...env });
  delete probeEnv.HERMES_EPHEMERAL_SYSTEM_PROMPT;
  delete probeEnv.PAPERCLIP_API_KEY;
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(probeEnv)) {
    if (typeof value === "string") cleanEnv[key] = value;
  }
  return cleanEnv;
}

function quoteForCmd(arg: string): string {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveWindowsSystemBinary(
  binaryName: string,
  env: Record<string, string>,
): string {
  const systemRoot = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", binaryName);
}

export function buildWindowsCmdProbeTarget(
  resolvedCommand: string,
  probeArgs: readonly string[],
  env: Record<string, string>,
): { command: string; args: string[] } {
  const shell = resolveWindowsSystemBinary("cmd.exe", env);
  const commandLine = [quoteForCmd(resolvedCommand), ...probeArgs.map(quoteForCmd)].join(" ");
  return { command: shell, args: ["/d", "/s", "/c", commandLine] };
}

export function buildWindowsTaskkillSpec(
  pid: number,
  env: Record<string, string>,
): { command: string; args: string[] } {
  return {
    command: resolveWindowsSystemBinary("taskkill.exe", env),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(
      candidate,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveWindowsProbeCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : command;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(";").filter(Boolean);
  const exts = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const candidatesForDir = (dir: string) =>
    path.extname(command).length > 0
      ? [path.join(dir, command)]
      : exts.map((ext) => path.join(dir, `${command}${ext}`));
  for (const dir of dirs) {
    for (const candidate of candidatesForDir(dir)) {
      if (await pathExists(candidate)) return candidate;
    }
  }
  return command;
}

async function resolveProbeSpawnTarget(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ command: string; args: string[] }> {
  const probeArgs = ["chat", "--help"];
  if (process.platform !== "win32") {
    return { command, args: probeArgs };
  }
  const resolved = await resolveWindowsProbeCommand(command, cwd, env);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return buildWindowsCmdProbeTarget(resolved, probeArgs, env);
  }
  return { command: resolved, args: probeArgs };
}

/**
 * Kill the probe and its full process tree.
 *
 * On POSIX, the probe runs in its own process group so a wrapper script or
 * launcher is signaled too. On Windows, `taskkill /PID <pid> /T /F` stops
 * `cmd.exe` `.cmd`/`.bat` wrappers along with any child Hermes process they
 * launched. The shared running-process registry is not used on purpose: it is
 * keyed by run id and holds the agent process itself, so registering the probe
 * would hand operator cancellation to the wrong pid.
 */
async function killProbeTree(
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal: NodeJS.Signals) => boolean;
  },
  env: Record<string, string>,
): Promise<void> {
  if (process.platform === "win32") {
    if (typeof child.pid === "number" && child.pid > 0) {
      const taskkill = buildWindowsTaskkillSpec(child.pid, env);
      try {
        await execFileAsync(taskkill.command, taskkill.args, {
          timeout: TASKKILL_TIMEOUT_MS,
          windowsHide: true,
        });
      } catch {
        // The tree may have exited already, or taskkill could not be launched;
        // fall through to direct child termination if it is still alive.
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }

  if (typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone, or the child never became a group leader;
      // fall through and signal the child directly.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Ask the CLI whether it supports `--query-file`.
 *
 * Returns `true` when the flag is advertised, `false` when help printed
 * successfully without it, and `null` when the probe itself is inconclusive.
 * A `null` result must never be treated as support.
 */
export async function hermesSupportsQueryFile(
  input: HermesQueryFileProbeInput,
): Promise<HermesQueryFileProbeResult> {
  const timeoutMs = Math.max(1000, Math.min(input.timeoutMs ?? 20_000, 60_000));
  const signal = input.signal;

  if (signal?.aborted) return null;

  const probeEnv = buildProbeEnv(input.env);
  const target = await resolveProbeSpawnTarget(input.command, input.cwd, probeEnv);

  if (signal?.aborted) return null;

  return new Promise<HermesQueryFileProbeResult>((resolve) => {
    let settled = false;
    let closed = false;
    let errored = false;
    let cancelled = false;
    let terminating = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const closeWaiters: Array<() => void> = [];

    const notifyWaiters = () => {
      while (closeWaiters.length > 0) {
        const wake = closeWaiters.shift();
        wake?.();
      }
    };

    const waitForStop = (maxWaitMs: number): Promise<void> => {
      if (closed || errored) return Promise.resolve();
      return new Promise<void>((done) => {
        let woke = false;
        const wake = () => {
          if (woke) return;
          woke = true;
          clearTimeout(graceTimer);
          done();
        };
        const graceTimer = setTimeout(wake, maxWaitMs);
        graceTimer.unref?.();
        closeWaiters.push(wake);
      });
    };

    const finish = (value: HermesQueryFileProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, target.args, {
        cwd: input.cwd,
        env: probeEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // Own process group on POSIX, so killProbeTree reaches wrapper children.
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }

    const terminateAndFail = async () => {
      if (settled || terminating) return;
      terminating = true;
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
      await killProbeTree(child, probeEnv);
      await waitForStop(PROBE_STOP_GRACE_MS);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null);
    };

    // SIGKILL / taskkill /T /F rather than SIGTERM: the probe only reads help
    // text, and a wedged launcher or child must not outlive the timeout.
    timer = setTimeout(() => {
      void terminateAndFail();
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        void terminateAndFail();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // A child that cannot start emits 'error' asynchronously. Unhandled, that
    // is an uncaught exception that would take down the Paperclip server.
    child.on("error", () => {
      errored = true;
      notifyWaiters();
      finish(null);
    });

    let out = "";
    const collect = (chunk: Buffer | string) => {
      // Cap the buffer: help text is a few kilobytes, and a misbehaving binary
      // must not grow this string without bound.
      if (out.length >= MAX_PROBE_OUTPUT_CHARS) return;
      const remaining = MAX_PROBE_OUTPUT_CHARS - out.length;
      out += chunk.toString().slice(0, remaining);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("close", (code) => {
      closed = true;
      notifyWaiters();
      if (cancelled) return finish(null);
      if (hasQueryFileFlagInHelp(out)) return finish(true);
      // Conclusive absence requires help that actually printed and succeeded.
      if (code === 0 && out.trim().length > 0) return finish(false);
      finish(null);
    });
  });
}
