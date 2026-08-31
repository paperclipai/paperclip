// The kubernetes sandbox provider's execInPod watchdog fires when the
// WebSocket used to stream a command's stdout/stderr/status frames drops
// silently (network blip, pod OOM-killed mid-exec, apiserver restart) before
// the command produces a status frame. plugin.ts surfaces that as
// `timedOut: true` with the watchdog's own message in stderr so the caller
// can retry instead of hanging forever.
//
// Adapters previously treated every `timedOut: true` result as if the
// configured adapter wall-clock budget had elapsed, stamping a fabricated
// "Timed out after <configured>s" message even when the real cause was the
// sandbox exec channel dying long before that budget was reached. This
// helper lets adapters distinguish the two cases so the recorded error
// attributes the failure to the sandbox, not the adapter's own timeout.
export const SANDBOX_EXEC_TIMEOUT_ERROR_CODE = "sandbox_exec_timeout";

const EXEC_TIMEOUT_RE = /execInPod timed out after \d+ms \(pod=/i;

/**
 * True when `text` contains the kubernetes plugin's execInPod watchdog
 * marker (packages/plugins/sandbox-providers/kubernetes/src/pod-exec.ts).
 * Case-insensitive; safe to call with null/undefined stderr.
 *
 * This is a heuristic string match over stderr, a channel the agent's own
 * process also writes to. If a run's genuine output happens to reproduce the
 * full watchdog signature (message plus the parenthesized "(pod=" context),
 * it would be misattributed as a sandbox exec-channel timeout rather than
 * the adapter's own wall-clock timeout. Requiring the "(pod=" context (not
 * just the leading phrase) narrows this: it is the literal string pod-exec.ts
 * emits, not a phrase an agent would plausibly produce on its own. The
 * residual risk is accepted because this classification only affects error
 * attribution and telemetry (which bucket a timeout is filed under), a
 * cosmetic distinction. Callers must not attach irreversible semantics (for
 * example, billing decisions or auto-retry policies with side effects) to
 * this signal without a structured, out-of-band channel for the watchdog to
 * report through instead of sharing stderr with agent-authored output.
 */
export function detectSandboxExecTimeout(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXEC_TIMEOUT_RE.test(text);
}

/**
 * Returns the first line of `stderr` that matches the execInPod watchdog
 * marker, trimmed. Returns null when no line matches.
 */
export function extractSandboxExecTimeoutMessage(stderr: string): string | null {
  if (!stderr) return null;
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (EXEC_TIMEOUT_RE.test(trimmed)) return trimmed;
  }
  return null;
}
