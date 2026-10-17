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

import { spawn } from "node:child_process";

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
 * Kill the probe and anything it started.
 *
 * The probe runs in its own process group so that a wrapper script or a CLI
 * that shells out to a launcher is signalled too. The shared running-process
 * registry is not used on purpose: it is keyed by run id and holds the agent
 * process itself, so registering the probe would hand operator cancellation to
 * the wrong pid.
 */
function killProbeTree(child: {
  pid?: number;
  kill: (signal: NodeJS.Signals) => boolean;
}): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
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

  return new Promise<HermesQueryFileProbeResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    const finish = (value: HermesQueryFileProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, ["chat", "--help"], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // Own process group, so the kill above reaches whatever the CLI starts.
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }

    // SIGKILL rather than SIGTERM: the probe only reads help text, and a wedged
    // CLI that ignores SIGTERM must not outlive the timeout.
    timer = setTimeout(() => {
      killProbeTree(child);
      finish(null);
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        killProbeTree(child);
        finish(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // A child that cannot start emits 'error' asynchronously. Unhandled, that
    // is an uncaught exception that would take down the Paperclip server.
    child.on("error", () => finish(null));

    let out = "";
    const collect = (chunk: Buffer | string) => {
      // Cap the buffer: help text is a few kilobytes, and a misbehaving binary
      // must not grow this string without bound.
      if (out.length < 64 * 1024) out += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("close", (code) => {
      // Match the option as argparse prints it, so unrelated help prose that
      // happens to mention "query file" cannot produce a false positive.
      if (/(^|\s)--query-file(\s|$)/.test(out)) return finish(true);
      // Conclusive absence requires help that actually printed and succeeded.
      if (code === 0 && out.trim().length > 0) return finish(false);
      finish(null);
    });
  });
}
