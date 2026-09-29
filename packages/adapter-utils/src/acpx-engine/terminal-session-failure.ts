import { redactDiagnosticText, REDACTED_COMMAND_TEXT_VALUE } from "../command-redaction.js";
import { redactEnvForLogs } from "../server-utils.js";

export interface AcpxTerminalSessionFailure {
  category: string;
  title?: string;
  details?: string;
}

export interface AcpxTerminalSessionFailureDiagnostic extends AcpxTerminalSessionFailure {
  truncatedFields?: Array<"title" | "details">;
}

const CATEGORIES = new Set(["connection", "access", "limit", "service", "request", "unknown"]);
// Leave room under the server's 64 KiB run-log chunk limit even when every
// retained character needs JSON escaping. The transcript stores the text once.
const FIELD_LIMITS = { title: 4096, details: 24576 } as const;

/** Keep provider diagnostics in the run, after redaction and before truncation. */
export function sanitizeTerminalSessionFailure(
  failure: AcpxTerminalSessionFailure,
  env: Record<string, string>,
  authToken?: string,
  configuredEnv: Record<string, unknown> = {},
): AcpxTerminalSessionFailureDiagnostic {
  const maskedEnv = redactEnvForLogs(env);
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && maskedEnv[key] !== value)
    .map(([, value]) => value);
  // Configured values can be resolved secret_refs under arbitrary names (for
  // example DATABASE_URL). Key-name heuristics cannot establish they are public.
  for (const value of Object.values(configuredEnv)) {
    if (typeof value === "string" && value) secrets.push(value);
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
  const diagnostic: AcpxTerminalSessionFailureDiagnostic = {
    category: CATEGORIES.has(failure.category) ? failure.category : "unknown",
  };
  for (const field of ["title", "details"] as const) {
    const raw = failure[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    let text = raw;
    for (const secret of secretForms) {
      text = text.replaceAll(secret, REDACTED_COMMAND_TEXT_VALUE);
    }
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
