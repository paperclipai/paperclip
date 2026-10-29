import { verifyCodexBwrapSandbox } from "./bwrap-sandbox-check.js";
import { resolveCodexCommand } from "./codex-command.js";

export interface CodexBwrapGateOptions {
  /**
   * Environment the session will run with. The opt-out is honored here first
   * (the operator may scope the opt-out to this session) and in the process
   * environment (instance-wide).
   */
  environment?: Record<string, string | undefined> | null;
  /**
   * The Codex command this session launches. Anchors the probe on the
   * installation that actually runs, so a healthy PATH Codex is not
   * refused because this package's own bundled sandbox is broken.
   */
  anchorPath?: string | null;
  /** Aborts the in-flight probe when the run is cancelled. */
  signal?: AbortSignal | null;
}

/**
 * Resolve the Codex executable the default process transport launches for
 * this session, using the session's environment and directory. Returns null
 * when no installation resolves: the transport reports the launch failure
 * itself, and the gate falls back to its module context for the probe.
 */
export function resolveLaunchedCodexExecutable(
  environment: NodeJS.ProcessEnv | undefined,
  workingDirectory: string,
): string | null {
  try {
    return resolveCodexCommand(undefined, environment, workingDirectory);
  } catch {
    return null;
  }
}

/**
 * Fail closed when the Codex bwrap sandbox is not operational on this host.
 *
 * The Codex CLI uses bwrap to confine its shell commands; if bwrap cannot
 * initialize (e.g. AppArmor denies mount), every command would run
 * unsandboxed. Rather than silently degrading, refuse to start the session
 * so the failure is visible to the caller and the ops channel.
 *
 * Skip and opt-out semantics:
 * - Vitest runs (`process.env.VITEST === "true"`, the value vitest sets in
 *   its main process and workers) skip the gate entirely so unit and
 *   integration tests never depend on the host's AppArmor/bwrap state; the
 *   check itself is covered by bwrap-sandbox-check tests.
 * - `PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED=1` skips the gate (operators and
 *   environments that cannot probe the sandbox at all).
 * - `PAPERCLIP_RUNNER_BWRAP_OPTOUT=1` (session or process environment)
 *   accepts unsandboxed execution with a logged warning.
 */
export async function assertCodexBwrapSandboxReady(
  options: CodexBwrapGateOptions = {},
): Promise<void> {
  if (process.platform !== "linux") return;
  if (process.env.VITEST === "true") return;
  if (process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED === "1") return;
  const check = await verifyCodexBwrapSandbox({
    anchorPath: options.anchorPath,
    signal: options.signal,
  });
  // A stop during the probe window is a cancellation, not a sandbox
  // failure: propagate the abort so the caller's stop handling applies
  // (same semantics as the ACPX engine gate).
  options.signal?.throwIfAborted();
  if (check.ok) return;
  const optedOut =
    options.environment?.PAPERCLIP_RUNNER_BWRAP_OPTOUT === "1" ||
    process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT === "1";
  if (optedOut) {
    // Explicitly accepted: continue, but surface the condition so the run
    // is auditable.
    process.stderr.write(
      `[paperclip] WARNING: bwrap sandbox is not operational (${check.reason}). ` +
      `Continuing without sandbox isolation because PAPERCLIP_RUNNER_BWRAP_OPTOUT=1 is set.\n`,
    );
    return;
  }
  throw new Error(
    `Sandbox unavailable: ${check.reason}. ` +
    `Refusing to start Codex without an operational bwrap sandbox. ` +
    `Fix the host sandbox prerequisites (AppArmor, user namespaces) or ` +
    `set PAPERCLIP_RUNNER_BWRAP_OPTOUT=1 to explicitly accept unsandboxed execution.`,
  );
}
