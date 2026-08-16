import { redactDiagnosticText } from "@paperclipai/adapter-utils";

// The server log keeps a bounded diagnostic. The bound stops a very large probe
// output from filling the log.
const MAX_LOGGED_PROBE_DIAGNOSTIC_CHARS = 2000;

// The login hint may show a login URL. The URL must be a normalized https URL
// with an allowlisted Claude or Anthropic host and no query or fragment. A host
// matches when it equals a suffix or ends with a dot and the suffix.
const ALLOWED_LOGIN_URL_HOST_SUFFIXES = ["anthropic.com", "claude.ai"] as const;

/**
 * Send a sandbox probe or config materialization diagnostic to the server log.
 *
 * Three Test-lane call sites use this helper:
 *   - the Claude CLI Test lane (`test.ts`),
 *   - the Claude ACP Test lane (`acp.ts`),
 *   - the managed-config materialization step (`claude-config.ts`).
 *
 * The helper is the single boundary where a raw probe error, stdout, or stderr
 * string reaches an output. It redacts secrets with `redactDiagnosticText`
 * first, so no credential reaches the log. The sanitizer redacts shell
 * `KEY=value` secrets and JSON secret fields such as `{"token":"..."}`. The
 * helper also bounds the length. A caller must never copy the raw string into a
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
  const redacted = redactDiagnosticText(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LOGGED_PROBE_DIAGNOSTIC_CHARS);
  if (!redacted) return;
  console.warn(`[paperclip] ${context}`, { detail: redacted });
}

/**
 * Normalize an untrusted login URL for a Test-result hint.
 *
 * The extractor reads the URL from raw sandbox stdout or stderr, so the value is
 * untrusted. The function accepts the URL only when every rule holds:
 *   - the protocol is `https`,
 *   - the host equals or ends with an allowlisted Claude or Anthropic host,
 *   - the URL has no user, password, or port,
 *   - the URL has no query and no fragment.
 *
 * The function returns the normalized URL string, or `null` when any rule
 * fails. The caller shows a fixed `claude login` hint when the function returns
 * `null`.
 */
export function normalizeClaudeLoginUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_LOGIN_URL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) return null;
  return url.toString();
}

/**
 * Build the fixed auth-required hint for a Test-result check. When the login URL
 * normalizes to a safe value, the hint names it. Otherwise the hint tells the
 * operator to run `claude login`.
 */
export function buildClaudeLoginRequiredHint(loginUrl: string | null | undefined): string {
  const safeUrl = normalizeClaudeLoginUrl(loginUrl);
  return safeUrl
    ? `Run \`claude login\` and complete sign-in at ${safeUrl}, then retry.`
    : "Run `claude login` in this environment, then retry the probe.";
}
