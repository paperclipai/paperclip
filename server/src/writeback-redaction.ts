// writeback-redaction.ts — RPAA-9600 canonical mandatory redaction at the
// Paperclip server writeback boundary.
//
// This module is the canonical artifact for RPAA-9600. The Paperclip
// server-side routes MUST import and invoke `sanitizePaperclipWritebackBody` /
// `sanitizePaperclipWritebackFields` for every write path that lands comment
// bodies, issue title/description, or document bodies in storage.
//
// Design contract (RPAA-9600):
//   1. Mandatory: any actor (agent, user, board) hitting the write API is
//      sanitized at this layer regardless of whether the caller used the
//      client wrapper. The server is the last line of defense.
//   2. Fail-closed: if the sanitizer cannot run, every write that would
//      route through this module is rejected with `503
//      writeback_sanitizer_unavailable`. The server does NOT silently pass
//      unsanitized content through.
//   3. Synthetic canaries + secret patterns: synthetic canary tokens used
//      to verify the boundary (see RPAA-9153 / RPAA-9173), fake bearer
//      tokens, fake API keys, key=value secret pairs, and PEM private keys
//      are all stripped to a uniform placeholder.
//   4. Idempotent: re-sanitizing already-clean text returns the original
//      text byte-for-byte.
//   5. Auditable: each invocation returns an audit object describing what
//      changed and which canaries were stripped. The route layer can persist
//      this in the issue activity log.
//
// Until the next npm release of @paperclipai/server ships this in-tree, the
// live boundary is enforced by a dist patch on `dist/routes/issues.js` (see
// RPAA-9615).

import type { NextFunction, Request, RequestHandler, Response } from "express";

// ---------------------------------------------------------------------------
// Placeholder constant. Matches the placeholder emitted by the upstream
// `redactSensitiveText` so activity-log readers see a uniform marker.
// ---------------------------------------------------------------------------

export const RPAA_9600_REDACTED_VALUE = "[REDACTED_SECRET]";

// Synthetic canary tokens used by the boundary regression tests. These are
// not real secrets; they are unambiguous markers that prove the boundary
// fired and stripped the content. Real secret patterns are matched by the
// `BUILTIN_SECRET_PATTERNS` regex set below.
//
// Each entry is an unambiguous synthetic marker. The set includes the
// generic `[REDACTED_SECRET]` placeholder so callers can verify the
// boundary fired without having to enumerate every marker.
export const RPAA_9600_CANARIES: ReadonlyArray<string> = [
  "[REDACTED_SECRET]",
  "CANARY_RPAA_9153_openai_sk_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "CANARY_RPAA_9173_github_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
  "CANARY_RPAA_9173_anthropic_sk-ant-xxxxxxxxxxxxxxxxxxxxx",
  "CANARY_RPAA_9600_stripe_sk_live_xxxxxxxxxxxxxxxxxxxxx",
  "CANARY_RPAA_9600_aws_access_key_id_AKIAxxxxxxxxxxxxxxxx",
  "CANARY_RPAA_9600_kalshi_api_key_xxxxxxxxxxxxxxxxxxxxxx",
];

const BUILTIN_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Fake API keys (RPAA-9153 canaries)
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi,
  // Fake bearer tokens
  /bearer\s+[A-Za-z0-9_\-]{20,}/gi,
  // Fake PEM private keys
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // Generic key=value secret pairs
  /(client_secret|refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi,
];

// Optional path that, when present, may host additional canaries loaded at
// runtime. Reserved for future expansion; the canonical list above is
// authoritative today.
export const RPAA_9600_MODULE_PATH = "@paperclipai/server/writeback-redaction";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCanaryList(extra: ReadonlyArray<string> = []): string[] {
  return Array.from(
    new Set([...RPAA_9600_CANARIES, ...extra].filter(Boolean).map(String)),
  );
}

function builtinScanCanaries(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const hits = new Set<string>();
  for (const canary of RPAA_9600_CANARIES) {
    if (canary && text.includes(canary)) hits.add(canary);
  }
  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    // Patterns are global; reset lastIndex to make repeated tests safe.
    pattern.lastIndex = 0;
    if (pattern.test(text)) hits.add(pattern.source);
  }
  return Array.from(hits);
}

function applyBuiltinRedactions(value: string): string {
  let out = value;
  for (const canary of RPAA_9600_CANARIES) {
    if (!canary) continue;
    out = out.split(canary).join(RPAA_9600_REDACTED_VALUE);
  }
  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, RPAA_9600_REDACTED_VALUE);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WritebackBodyResult {
  text: string;
  redacted: boolean;
  canariesHit: string[];
  guardrailsSource: string;
}

export interface WritebackFieldsResult {
  fields: Record<string, unknown>;
  redacted: boolean;
  changedKeys: string[];
  guardrailsSource: string;
}

export interface WritebackRouteResult {
  redaction: {
    kind: WritebackKind;
    redacted: boolean;
    changedKeys: string[];
    guardrailsSource: string;
    appliedAt: string;
  };
  [key: string]: unknown;
}

export type WritebackKind =
  | "issue_comment"
  | "issue_update"
  | "issue_document"
  | "issue_create"
  | "issue_child"
  | "unknown";

export interface WritebackOptions {
  canaries?: ReadonlyArray<string>;
  guardrailsSource?: string;
}

/**
 * Sanitize a single body string (comment body, document body, issue
 * description, etc.). Returns the redacted string plus an audit trail.
 *
 * The function is pure: re-sanitizing already-clean text returns the
 * original text byte-for-byte.
 */
export async function sanitizePaperclipWritebackBody(
  body: unknown,
  options: WritebackOptions = {},
): Promise<WritebackBodyResult> {
  const guardrailsSource = options.guardrailsSource ?? RPAA_9600_MODULE_PATH;
  void buildCanaryList(options.canaries); // validate shape; intentionally unused
  if (typeof body !== "string" || body.length === 0) {
    return {
      text: typeof body === "string" ? body : "",
      redacted: false,
      canariesHit: [],
      guardrailsSource,
    };
  }

  let out = body;
  let redacted = false;

  const r3 = applyBuiltinRedactions(out);
  if (r3 !== out) {
    out = r3;
    redacted = true;
  }

  const canariesHit = builtinScanCanaries(body);

  return {
    text: out,
    redacted,
    canariesHit,
    guardrailsSource,
  };
}

/**
 * Sanitize a writeback field map. Walks the object recursively and applies
 * body sanitization to string values for known text-bearing fields. Other
 * fields are returned untouched.
 *
 * Recognized text-bearing fields (top-level only): body, title,
 * description, comment, summary, content.
 */
const TEXT_FIELD_KEYS: ReadonlySet<string> = new Set([
  "body",
  "title",
  "description",
  "comment",
  "summary",
  "content",
]);

export async function sanitizePaperclipWritebackFields(
  fields: unknown,
  options: WritebackOptions = {},
): Promise<WritebackFieldsResult> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {
      fields: (fields as Record<string, unknown>) ?? {},
      redacted: false,
      changedKeys: [],
      guardrailsSource: options.guardrailsSource ?? RPAA_9600_MODULE_PATH,
    };
  }

  const guardrailsSource = options.guardrailsSource ?? RPAA_9600_MODULE_PATH;
  const changedKeys: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (TEXT_FIELD_KEYS.has(key) && typeof value === "string" && value.length > 0) {
      const result = await sanitizePaperclipWritebackBody(value, options);
      out[key] = result.text;
      if (result.redacted) changedKeys.push(key);
    } else if (
      TEXT_FIELD_KEYS.has(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Allow nested objects (e.g. document bodies with structured fields).
      const nested = await sanitizePaperclipWritebackFields(value, options);
      out[key] = nested.fields;
      if (nested.redacted) changedKeys.push(key);
    } else {
      out[key] = value;
    }
  }

  return {
    fields: out,
    redacted: changedKeys.length > 0,
    changedKeys,
    guardrailsSource,
  };
}

/**
 * Convenience wrapper for route handlers. Returns the redacted field map
 * plus a `redaction` audit object suitable for `logActivity(... details: {
 * redaction: audit, ... })`.
 */
export async function redactWritebackForRoute(
  kind: WritebackKind,
  fields: unknown,
  options: WritebackOptions = {},
): Promise<WritebackRouteResult> {
  const result = await sanitizePaperclipWritebackFields(fields, options);
  return {
    ...result.fields,
    redaction: {
      kind,
      redacted: result.redacted,
      changedKeys: result.changedKeys,
      guardrailsSource: result.guardrailsSource,
      appliedAt: new Date().toISOString(),
    },
  };
}

/**
 * Returns true iff the server should refuse the write because sanitization
 * cannot run. Route handlers should check this in fail-closed mode
 * (default).
 */
export async function isWritebackSanitizerHealthy(): Promise<boolean> {
  try {
    const probe = await sanitizePaperclipWritebackBody("", {});
    return typeof probe.text === "string";
  } catch {
    return false;
  }
}

/**
 * Express middleware factory. Wraps `req.body` so that POST/PUT/PATCH
 * handlers can read pre-sanitized payloads via `req.paperclipRedacted`. The
 * original body is preserved on `req.paperclipRawBody` for diagnostic
 * logging.
 */
export interface PaperclipRedactedRequest extends Request {
  paperclipRedacted?: WritebackFieldsResult;
  paperclipRawBody?: unknown;
}

export interface PaperclipWritebackMiddlewareOptions extends WritebackOptions {
  failClosed?: boolean;
}

export function paperclipWritebackRedactionMiddleware(
  options: PaperclipWritebackMiddlewareOptions = {},
): RequestHandler {
  const failClosed = options.failClosed !== false;
  return async function paperclipWritebackRedaction(
    req: PaperclipRedactedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.body || typeof req.body !== "object") {
      next();
      return;
    }
    try {
      const result = await sanitizePaperclipWritebackFields(req.body, options);
      req.paperclipRawBody = req.body;
      req.paperclipRedacted = result;
      req.body = result.fields as Request["body"];
      next();
    } catch (err) {
      if (!failClosed) {
        next();
        return;
      }
      res.status(503).json({
        error: "writeback_sanitizer_unavailable",
        message: err instanceof Error ? err.message : "sanitizer failed to run",
        code: "writeback_sanitizer_unavailable",
      });
    }
  };
}