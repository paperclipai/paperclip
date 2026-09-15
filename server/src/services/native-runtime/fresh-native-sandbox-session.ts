import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

/** Internal dispatch authority, never taken from adapter configuration or model input. */
export interface FreshNativeSessionAuthority {
  runId: string;
  normalizedSessionId: string;
}

export async function claimFreshNativeSandboxSession(input: {
  authority?: FreshNativeSessionAuthority;
  runId: string;
  normalizedSessionId: string;
  hasPriorState: boolean;
  runner: CommandManagedRuntimeRunner;
  sessionRoot: string;
}): Promise<void> {
  if (input.hasPriorState || !input.authority ||
      input.authority.runId !== input.runId ||
      input.authority.normalizedSessionId !== input.normalizedSessionId) {
    throw new Error("runner_harness_state_mismatch");
  }
  if (!(await claimNativeSandboxSessionDirectory(input.runner, input.sessionRoot))) {
    throw new Error("runner_harness_state_mismatch");
  }
}

/** Call only after dispatch authority or an exact untouched bootstrap is verified. */
export async function claimNativeSandboxSessionDirectory(
  runner: CommandManagedRuntimeRunner,
  sessionRoot: string,
): Promise<boolean> {
  if (!posix.isAbsolute(sessionRoot)) return false;
  const sessionsRoot = posix.dirname(sessionRoot);
  const runtimeRoot = posix.dirname(sessionsRoot);
  // Both existing parent directories must be real and readable. An atomic
  // mkdir claims only the absent session; partial roots and symlinks stay intact.
  const claimed = await runner.execute({
    command: "sh",
    args: ["-c",
      'set -eu; umask 077; test -d "$1" && test ! -L "$1" && test -r "$1" && test -x "$1" || exit 1; if test ! -e "$2" && test ! -L "$2"; then mkdir -- "$2"; fi; test -d "$2" && test ! -L "$2" && test -r "$2" && test -x "$2" || exit 1; mkdir -- "$3"',
      "paperclip-runner-claim-unstarted-session", runtimeRoot, sessionsRoot, sessionRoot],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  return claimed.exitCode === 0 && !claimed.timedOut;
}
