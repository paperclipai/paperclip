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
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // mkdir without -p atomically proves the new session has no existing state,
  // including an incomplete bootstrap or a symlink. Never clear an old root.
  const claimed = await input.runner.execute({
    command: "sh",
    args: ["-c", `umask 077; mkdir -p ${quote(posix.dirname(input.sessionRoot))} && mkdir ${quote(input.sessionRoot)}`],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  if (claimed.exitCode !== 0 || claimed.timedOut) {
    throw new Error("runner_harness_state_mismatch");
  }
}
