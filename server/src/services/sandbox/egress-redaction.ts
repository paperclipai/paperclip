/**
 * Phase 4A-3 (LET-323) / Phase 4A-S6 (LET-352): redaction pipeline for
 * egress proxy intents and decisions. Producers (the future sandbox proxy
 * worker, the REST preview endpoint, the audit/evidence hook) MUST pipe the
 * raw intent through `redactEgressIntent` before persisting, logging,
 * returning over REST, or publishing on the sandbox event bus.
 *
 * Preview / stub only: there is no real egress proxy yet — see ADR LET-328
 * for the buy-vs-build decision. Audit records describe what a future real
 * proxy *would* have logged, not traffic that actually flowed.
 *
 * Guarantees:
 *   - Full URL is never echoed — the path is collapsed to a short digest
 *     so audit can correlate without leaking endpoints or path-embedded
 *     tokens (e.g. `/v1/secrets/abc123`).
 *   - Query strings are dropped entirely; only the number of params is
 *     preserved.
 *   - Header VALUES are never echoed. Header NAMES are preserved when
 *     non-sensitive so downstream UIs can show which categories of
 *     metadata would have been forwarded.
 *   - Sensitive header names (Authorization, Cookie, Set-Cookie, X-Api-Key,
 *     Proxy-Authorization, X-Amz-Security-Token, …) are dropped entirely.
 *   - Host is normalized to lowercase and classified, but kept legible —
 *     the network policy already controls whether a host is allowlisted,
 *     so the host itself is part of the audit record.
 */

import { createHash } from "node:crypto";
import { redactLearningEvidence } from "@paperclipai/shared";
import type {
  EgressDecision,
  EgressIntent,
  EgressTargetClassification,
} from "./egress-policy.js";

export interface RedactedEgressIntent {
  method: string;
  host: string;
  port: number | null;
  protocol: string;
  pathDigest: string | null;
  /** Number of query params seen (zero when the URL had none). */
  queryParamCount: number;
  headerNames: string[];
  redactedHeaderCount: number;
  targetKind: EgressIntent["targetKind"] | null;
}

const SENSITIVE_HEADER_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-amz-security-token$/i,
  /^x-amz-content-sha256$/i,
  /^x-goog-api-key$/i,
  /^x-vault-token$/i,
  /^api[-_]?key$/i,
  // Substring matches so names like X-Authorization,
  // X-Forwarded-Authorization, Authentication, X-Authentication-Info, …
  // are all dropped — not just the exact RFC names above.
  /authorization/i,
  /authentication/i,
  /token/i,
  /secret/i,
  /credential/i,
  /password/i,
  /bearer/i,
  /session/i,
];

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function digestPath(path: string): string | null {
  if (!path || path === "/" || path.length === 0) return null;
  const hash = createHash("sha256").update(path).digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

function normalizeMethod(method: string): string {
  if (typeof method !== "string") return "GET";
  const upper = method.toUpperCase().replace(/[^A-Z]/g, "");
  return upper.length === 0 ? "GET" : upper.slice(0, 16);
}

function normalizeHost(host: string): string {
  const lower = (host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (lower.length === 0 || lower.length > 253) return "invalid";
  if (lower === "localhost" || lower === "::1") return lower;
  if (IPV4_PATTERN.test(lower)) {
    return lower
      .split(".")
      .every((part) => {
        const value = Number.parseInt(part, 10);
        return Number.isInteger(value) && value >= 0 && value <= 255;
      })
      ? lower
      : "invalid";
  }
  if (lower.includes(":")) {
    return lower
      .split(":")
      .every((segment) => segment === "" || /^[0-9a-f]{1,4}$/i.test(segment))
      ? lower
      : "invalid";
  }
  if (!HOST_PATTERN.test(lower)) return "invalid";
  return lower;
}

function isSensitiveHeaderName(name: string): boolean {
  for (const pattern of SENSITIVE_HEADER_PATTERNS) {
    if (pattern.test(name)) return true;
  }
  return false;
}

/**
 * Build the safe-for-audit projection of an egress intent. Never throws —
 * malformed input still produces a record (with `host: "invalid"` and an
 * empty path digest). Callers that want a parse error should call
 * `evaluateEgressIntent` (which surfaces `DENY_INVALID_TARGET`).
 */
export function redactEgressIntent(intent: EgressIntent): RedactedEgressIntent {
  const headerNames: string[] = [];
  let redactedHeaderCount = 0;
  if (intent.headers) {
    for (const name of Object.keys(intent.headers)) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (isSensitiveHeaderName(name)) {
        redactedHeaderCount += 1;
        continue;
      }
      // Normalize the casing but otherwise preserve the header name.
      headerNames.push(name.toLowerCase());
    }
    headerNames.sort();
  }

  let host = "invalid";
  let port: number | null = null;
  let protocol = "other";
  let pathDigest: string | null = null;
  let queryParamCount = 0;

  if (typeof intent.url === "string" && intent.url.length > 0) {
    try {
      const parsed = new URL(intent.url);
      host = normalizeHost(parsed.hostname);
      port = parsed.port ? Number.parseInt(parsed.port, 10) || null : null;
      protocol = parsed.protocol.replace(/:$/, "").toLowerCase() || "other";
      pathDigest = digestPath(parsed.pathname);
      queryParamCount = Array.from(parsed.searchParams.keys()).length;
    } catch {
      // host stays "invalid"
    }
  }

  return {
    method: normalizeMethod(intent.method),
    host,
    port,
    protocol,
    pathDigest,
    queryParamCount,
    headerNames,
    redactedHeaderCount,
    targetKind: intent.targetKind ?? null,
  };
}

export interface EgressAuditRecord {
  readonly previewOnly: true;
  readonly redactedIntent: RedactedEgressIntent;
  readonly decision: EgressDecision;
  readonly classification: EgressTargetClassification;
  /** Free-form audit message, scrubbed for secret patterns. */
  readonly message: string;
}

/**
 * URL/path/query stripper for caller-supplied audit messages. The
 * `redactLearningEvidence` pass catches secret-shaped tokens, but not raw
 * URL/path/query fixtures. We collapse anything URL-shaped, plus any bare
 * path or query string, to a `[URL_REDACTED]` placeholder so accidental
 * raw fixtures from future callers cannot leak endpoints, IDs, or
 * path-embedded tokens through the audit hook.
 */
function scrubUrlsAndPaths(message: string): string {
  let out = message;
  // Full http(s)/ftp/ws/dns URLs (and anything with a scheme://host).
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi, "[URL_REDACTED]");
  // Bare query strings (e.g. "?token=abc&id=1" inside a longer string).
  out = out.replace(/\?[^\s'"<>`]*=[^\s'"<>`]*/g, "[QUERY_REDACTED]");
  // Bare absolute paths with at least one segment (e.g. "/v1/secrets/abc").
  out = out.replace(/(^|[\s(<])\/[A-Za-z0-9._~%\-/]+/g, "$1[PATH_REDACTED]");
  return out;
}

/**
 * Build a redacted audit record for an egress decision. The `message`
 * field is scrubbed for URL/path/query content first (so caller-supplied
 * raw fixtures cannot leak endpoints or path-embedded tokens) and then
 * runs through the learning-evidence redactor for known secret patterns.
 */
export function summarizeEgressAudit(input: {
  intent: EgressIntent;
  decision: EgressDecision;
  message?: string;
}): EgressAuditRecord {
  const redactedIntent = redactEgressIntent(input.intent);
  // LET-352: default message tags every record as `preview` so audit
  // consumers cannot read an allow/deny as evidence that real traffic
  // flowed. See ADR LET-328.
  const baseMessage =
    input.message ??
    `sandbox.egress[preview] ${input.decision.decision}: ${input.decision.reasonCode} (${redactedIntent.method} ${redactedIntent.host})`;
  return {
    previewOnly: true,
    redactedIntent,
    decision: input.decision,
    classification: input.decision.classification,
    message: redactLearningEvidence(scrubUrlsAndPaths(baseMessage)),
  };
}

export const __testing = {
  isSensitiveHeaderName,
  normalizeHost,
  digestPath,
  scrubUrlsAndPaths,
};
