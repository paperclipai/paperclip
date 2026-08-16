import { redactCommandText } from "@paperclipai/adapter-utils";

// The server log keeps a bounded diagnostic. The bound stops a very large probe
// output from filling the log.
const MAX_LOGGED_PROBE_DIAGNOSTIC_CHARS = 2000;

/**
 * Send a sandbox probe or config materialization diagnostic to the server log.
 *
 * Both the Claude CLI Test lane and the Claude ACP Test lane call this helper.
 * The helper is the single boundary where a raw probe error, stdout, or stderr
 * string reaches an output. It redacts secrets with the project standard
 * `redactCommandText` helper first, so no credential reaches the log. It also
 * bounds the length. A caller must never copy the raw string into a
 * Test-result check, because the user interface renders check text.
 *
 * @param context A short fixed description of the failed step. It carries no
 *   untrusted text.
 * @param raw The untrusted diagnostic from the sandbox. The helper redacts it.
 */
export function logRedactedSandboxProbeDiagnostic(
  context: string,
  raw: string | null | undefined,
): void {
  if (!raw) return;
  const redacted = redactCommandText(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LOGGED_PROBE_DIAGNOSTIC_CHARS);
  if (!redacted) return;
  console.warn(`[paperclip] ${context}`, { detail: redacted });
}
