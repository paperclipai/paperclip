import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";

/**
 * The fixed label a Test result shows when the probe runs on the local
 * Paperclip host. The label is a constant, so a local target check never
 * carries an environment ID, a config value, or a credential-derived string.
 */
export const ADAPTER_TEST_HOST_TARGET_LABEL = "Paperclip host";

// The login hint may show a login URL. The URL must be a normalized https URL
// with an allowlisted Claude or Anthropic host and no query or fragment. A host
// matches when it equals a suffix or ends with a dot and the suffix.
const ALLOWED_LOGIN_URL_HOST_SUFFIXES = ["anthropic.com", "claude.ai"] as const;

// A JavaScript error class name is a bounded identifier. The bound stops a very
// large or crafted class name from filling the log.
const MAX_ERROR_CLASS_NAME_CHARS = 64;

/**
 * The allowlisted classification for a sandbox probe diagnostic. The call site
 * picks one fixed label from this set. The label never holds a copy of
 * untrusted probe text.
 *
 *   - `timeout`: the probe process did not finish before the deadline.
 *   - `auth_required`: the probe ran and reported that login is required.
 *   - `nonzero_exit`: the probe process exited with a non-zero exit code.
 *   - `spawn_error`: the probe process, or a setup step, threw before it ran.
 *   - `empty_output`: the probe produced no output.
 *   - `unexpected_output`: the probe ran and exited zero, but the output did
 *     not match the expected reply.
 */
export type SandboxProbeDiagnosticClassification =
  | "timeout"
  | "auth_required"
  | "nonzero_exit"
  | "spawn_error"
  | "empty_output"
  | "unexpected_output";

/**
 * The safe structured fields a call site may add to a probe diagnostic. Each
 * field is a fixed shape, not free text. The helper drops any value that is not
 * safe.
 */
export interface SandboxProbeDiagnosticFields {
  // The process exit code. The helper logs it only when it is a finite number.
  exitCode?: number | null;
  // The class name of a thrown value. Use `classifyThrownErrorClass` to derive
  // it. The helper sanitizes it again before it logs it.
  errorClass?: string | null;
}

/**
 * Read the class name of a thrown value for a safe probe diagnostic. The
 * function returns the constructor name of an `Error`, or `null` for any other
 * value. The name is a bounded identifier, not a copy of the error message, so
 * it carries no untrusted probe text.
 */
export function classifyThrownErrorClass(err: unknown): string | null {
  if (err instanceof Error) return err.constructor?.name ?? "Error";
  return null;
}

// Keep only identifier characters and bound the length. The result cannot carry
// untrusted probe text.
function sanitizeErrorClassName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const safe = name.replace(/[^A-Za-z0-9_$]/g, "").slice(0, MAX_ERROR_CLASS_NAME_CHARS);
  return safe.length > 0 ? safe : null;
}

/**
 * Send a sandbox probe or config materialization diagnostic to the server log.
 *
 * Three Test-lane call sites use this helper:
 *   - the Claude CLI Test lane (`test.ts`),
 *   - the Claude ACP Test lane (`acp.ts`),
 *   - the managed-config materialization step (`claude-config.ts`).
 *
 * Contract: no untrusted text reaches the log. The helper logs only the fixed
 * context string, one allowlisted classification, and safe structured fields.
 * The safe fields are the process exit code and a sanitized error class name.
 * The helper never logs raw probe stdout, raw stderr, or a raw thrown-error
 * message. A call site must never copy raw probe text into a Test-result check,
 * because the user interface renders check text.
 *
 * @param context A short fixed description of the failed step. It carries no
 *   untrusted text.
 * @param classification One allowlisted label that the call site derives from
 *   the probe state. It carries no untrusted text.
 * @param fields Optional safe structured fields, such as the exit code.
 */
export function logSandboxProbeDiagnostic(
  context: string,
  classification: SandboxProbeDiagnosticClassification,
  fields?: SandboxProbeDiagnosticFields,
): void {
  const detail: {
    classification: SandboxProbeDiagnosticClassification;
    exitCode?: number;
    errorClass?: string;
  } = { classification };
  if (typeof fields?.exitCode === "number" && Number.isFinite(fields.exitCode)) {
    detail.exitCode = fields.exitCode;
  }
  const errorClass = sanitizeErrorClassName(fields?.errorClass);
  if (errorClass) detail.errorClass = errorClass;
  console.warn(`[paperclip] ${context}`, detail);
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

/**
 * Resolve the label a Test result shows for the probed target. A remote target
 * uses the authorized environment name. A remote target with no name uses a
 * fixed generic label. A local target uses the fixed host label. The function
 * never returns an environment ID, a config value, or a credential-derived
 * string.
 */
export function resolveAdapterTestTargetLabel(input: {
  targetIsRemote: boolean;
  environmentName: string | null | undefined;
}): string {
  if (!input.targetIsRemote) return ADAPTER_TEST_HOST_TARGET_LABEL;
  const name = typeof input.environmentName === "string" ? input.environmentName.trim() : "";
  return name.length > 0 ? name : "the selected environment";
}

/**
 * Build the target check every Test result carries, so the result names the
 * target it probed. Both the Claude CLI Test lane and the Claude ACP Test lane
 * use this builder. The check text carries only the authorized environment
 * label or the fixed host label.
 */
export function buildAdapterTestTargetCheck(input: {
  targetIsRemote: boolean;
  environmentName: string | null | undefined;
}): AdapterEnvironmentCheck {
  const label = resolveAdapterTestTargetLabel(input);
  return {
    code: "claude_environment_target",
    level: "info",
    message: input.targetIsRemote
      ? `Probing inside environment: ${label}`
      : "Probing on the Paperclip host.",
  };
}
