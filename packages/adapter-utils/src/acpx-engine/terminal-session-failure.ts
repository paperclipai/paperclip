import { redactDiagnosticText, REDACTED_COMMAND_TEXT_VALUE } from "../command-redaction.js";
import type { AdapterExecutionResult } from "../types.js";

export interface AcpxTerminalSessionFailure {
  category: string;
  title?: string;
  details?: string;
}

export interface AcpxTerminalSessionFailureDiagnostic extends AcpxTerminalSessionFailure {
  truncatedFields?: Array<"title" | "details">;
}

const CATEGORIES = new Set(["connection", "access", "limit", "service", "request", "unknown"]);

/** Inspect raw provider text before redaction can remove status codes or limits.
 * Only definition paths qualify: invalid call arguments and overloads remain
 * subject to their existing recovery contracts.
 */
export function classifyToolDefinitionFailure(
  failure: AcpxTerminalSessionFailure,
): Pick<AdapterExecutionResult, "errorCode" | "errorFamily"> | null {
  const text = `${failure.title ?? ""}\n${failure.details ?? ""}`;
  const definitionPath = /\btools(?:\.\d+|\[\d+\])(?:\.(?:custom|function))?\.(?:name|input_schema|parameters|description|type)\b/i;
  const validation = /at most|too long|max(?:imum)?[_ ]?length|invalid|not valid|must|should|schema|validation|unsupported/i;
  const namedDefinition = /(?:invalid|unsupported)\s+(?:tool|function)\s+(?:definition|schema|name)|invalid schema for (?:function|tool)/i;
  if ((definitionPath.test(text) && validation.test(text)) || namedDefinition.test(text)) {
    return { errorCode: "provider_tool_definition_invalid", errorFamily: "configuration" };
  }
  return null;
}
// Failures whose root cause is the session itself — the transport dropped
// mid-response, or the accumulated conversation no longer fits the context
// window / failed to compact. Resuming the same session only replays the same
// oversized/broken conversation, so the recovery path must rotate to a fresh
// session instead of growing the failed one toward the compaction cliff.
// Otherwise a transient blip becomes a per-task death spiral: every retry
// resumes the failed session and grows it further, never recovering.
const CONNECTION_LOSS_FAILURE =
  /connection (?:closed|lost|reset|aborted)|closed mid-response|socket hang\s?up|econnreset|epipe|stream (?:closed|ended|disconnected)|premature close|channel (?:was )?lost|closed before (?:the )?(?:response|completion|turn)/i;
const CONTEXT_SIZE_FAILURE =
  /prompt is too long|prompt too long|context (?:length|window) (?:exceeded|too large|limit)|too many (?:input )?tokens|maximum context (?:length|window)|exceeds the (?:maximum|context)|input (?:is )?too (?:large|long)/i;
const COMPACTION_FAILURE =
  /compact(?:ion)? (?:failed|error)|failed to compact|unable to compact|compaction (?:threshold|limit)/i;

/** True when a failure means the session must be reset (not resumed) on the
 * next attempt. Pure and side-effect free so it can be unit-tested directly and
 * reused by both the terminal-failure and mid-turn error paths. */
export function isSessionResetWorthyFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    CONNECTION_LOSS_FAILURE.test(message) ||
    CONTEXT_SIZE_FAILURE.test(message) ||
    COMPACTION_FAILURE.test(message)
  );
}

// Leave room under the server's 64 KiB run-log chunk limit even when every
// retained character needs JSON escaping. The transcript stores the text once.
const FIELD_LIMITS = { title: 4096, details: 24576 } as const;
// Only conventional public process settings may survive by default. Provider,
// proxy, bridge, and future launch contributions may carry secrets under any
// name. Explicitly configured values are still redacted even for these keys.
const PUBLIC_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG",
  "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "NODE_ENV",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID",
]);
const PUBLIC_BOOLEAN_ENV_KEYS = new Set([
  "OPENCODE_ALLOW_ALL_MODELS", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_GENAI_USE_GCA",
  "CI", "NO_COLOR", "FORCE_COLOR",
]);

function isPublicBooleanSetting(key: string, value: string): boolean {
  return PUBLIC_BOOLEAN_ENV_KEYS.has(key.toUpperCase()) && /^(?:0|1|true|false)$/i.test(value);
}

/** Keep provider diagnostics in the run, after redaction and before truncation. */
export function sanitizeTerminalSessionFailure(
  failure: AcpxTerminalSessionFailure,
  env: Record<string, string>,
  authToken?: string,
  configuredEnv: Record<string, unknown> = {},
): AcpxTerminalSessionFailureDiagnostic {
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && !PUBLIC_ENV_KEYS.has(key.toUpperCase()) && !isPublicBooleanSetting(key, value))
    .map(([, value]) => value);
  // Configured values can be resolved secret_refs under arbitrary names (for
  // example DATABASE_URL). Key-name heuristics cannot establish they are public.
  for (const [key, value] of Object.entries(configuredEnv)) {
    if (typeof value === "string" && value && !isPublicBooleanSetting(key, value)) secrets.push(value);
  }
  // A provider may echo just the password from a configured connection URL.
  for (const value of Object.values(env)) {
    try {
      const url = new URL(value);
      if (url.password) {
        secrets.push(value, url.password, decodeURIComponent(url.password));
      }
    } catch { /* ordinary environment values are not URLs */ }
  }
  if (authToken) secrets.push(authToken);
  const secretForms = [...new Set(secrets.flatMap((value) => {
    const forms = [value, JSON.stringify(value).slice(1, -1)];
    // A malformed Unicode credential must not discard the entire diagnostic.
    try { forms.push(encodeURIComponent(value)); } catch { /* retain literal forms */ }
    return forms;
  }))].sort((a, b) => b.length - a.length);
  // Replace in one pass so a short value cannot modify a redaction marker
  // inserted for a longer value or cause repeated marker expansion.
  const secretPattern = secretForms.length > 0
    ? new RegExp(secretForms.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu")
    : null;
  const diagnostic: AcpxTerminalSessionFailureDiagnostic = {
    category: CATEGORIES.has(failure.category) ? failure.category : "unknown",
  };
  for (const field of ["title", "details"] as const) {
    const raw = failure[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    let text = secretPattern ? raw.replace(secretPattern, () => REDACTED_COMMAND_TEXT_VALUE) : raw;
    text = redactDiagnosticText(text)
      // Keep line breaks and tabs for provider JSON and stack traces, but strip
      // terminal control sequences and characters PostgreSQL cannot store.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\ud800-\udfff]/gu, "\ufffd")
      .trim();
    const limit = FIELD_LIMITS[field];
    if (text.length > limit) {
      (diagnostic.truncatedFields ??= []).push(field);
      // Do not split a UTF-16 surrogate pair into invalid JSONB text.
      const end = (text.codePointAt(limit - 1) ?? 0) > 0xffff ? limit - 1 : limit;
      text = `${text.slice(0, end)}\n[truncated: ${text.length - end} characters omitted]`;
    }
    if (text) diagnostic[field] = text;
  }
  return diagnostic;
}

export function formatTerminalSessionFailure(
  message: string | null,
  diagnostic: AcpxTerminalSessionFailureDiagnostic | null,
): string | null {
  if (!diagnostic) return message;
  return [...new Set([message, diagnostic.title, diagnostic.details].filter(Boolean))].join("\n");
}
