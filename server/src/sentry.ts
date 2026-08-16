// Optional Sentry error-report integration for the server process.
//
// Activated only when `SENTRY_DSN` is set. When unset, no Sentry package is
// loaded at all. The `@sentry/node` package is an optional dependency, so a
// self-hoster who wants error reports installs it explicitly. That keeps Sentry
// off the default dependency graph, the same way `instrumentation.ts` keeps the
// OpenTelemetry packages optional.
//
// The integration has two operator-selected trust levels. The operator sets the
// level with `SENTRY_TRUST_LEVEL`. The value is `high` or `low`. The default is
// `low`. The level comes only from the environment at process start. No request
// input can change the level.
//
// - The low-trust level is the default. It runs when `SENTRY_TRUST_LEVEL` is
//   absent, `low`, or unrecognized. It sends a minimal, fail-closed event: the
//   redacted error plus a narrow typed context. It never sends the request
//   body, the headers, the cookies, the caller IP address, the user identity,
//   or the local variables.
// - The high-trust level runs only when the operator sets `SENTRY_TRUST_LEVEL`
//   to `high`. It sends richer debug data: the SDK-captured request metadata,
//   the breadcrumbs, the error context, and the stack-frame local variables. It
//   still keeps `sendDefaultPii: false`, so it does not send the cookies, the
//   caller IP address, or the user identity. It still removes secrets from every
//   event.
//
// Both levels run a secret-redaction pass over every event. Paperclip must never
// send its own secrets to a third party, at either level.

export type SentryTrustLevel = "high" | "low";

/**
 * The fixed set of capture-site sources. Each capture call names one. This PR
 * captures the fatal startup error only, so the union has one member. The union
 * grows as later capture sites land.
 */
export type CaptureSource = "startup-fatal";

/**
 * The narrow, typed capture context. A capture call passes only this bounded
 * field. The type rejects a raw request object, a request body, a headers
 * object, and every free-form key, so no unbounded personal data or secret can
 * reach a capture call by mistake. The `beforeSend` scrubber allowlists this
 * field onto the outbound event in the low-trust level.
 */
export type CaptureContext = {
  /** The capture site. Required. */
  source: CaptureSource;
};

// The event context key that carries the typed `CaptureContext`. `captureException`
// stashes the context here, so the low-trust allowlist reads it back and keeps
// only these fields.
const CAPTURE_CONTEXT_KEY = "paperclip_capture";

// The `CaptureContext` fields the low-trust allowlist keeps. It never keeps any
// other key. This list grows with `CaptureContext` as later capture sites land.
const CAPTURE_CONTEXT_FIELDS = ["source"] as const;

/**
 * The subset of the `@sentry/node` surface this module calls. The real package
 * satisfies it. Typing it this way keeps the module graph free of the optional
 * package: the dynamic import needs no static type from `@sentry/node`.
 */
interface SentryModule {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, captureContext?: unknown): string;
  flush(timeoutMs?: number): Promise<boolean>;
}

// Read the gate variables once at module evaluation. An empty or whitespace DSN
// counts as unset. Only the exact value `high` selects the high-trust level.
const dsn = process.env.SENTRY_DSN?.trim() || undefined;
const trustLevel: SentryTrustLevel =
  process.env.SENTRY_TRUST_LEVEL === "high" ? "high" : "low";

let sentryApi: SentryModule | null = null;
let enabled = false;
let flushPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// The `beforeSend` scrubber. It is the egress contract that protects every
// event. It has two strategies, chosen by the trust level.
// ---------------------------------------------------------------------------

// The secret-key denylist. It mirrors `SENSITIVE_KEYS` in
// `server/src/middleware/redact-sensitive.ts`. That module is read-only for this
// work and it does not export the set, so the set is repeated here. The scrubber
// needs a stronger pass than `redactSensitive`: it must scrub a secret inside a
// bare string (for example an exception message), which the key walker skips,
// and it must not truncate the high-trust debug data at the shared depth-six
// cap. So this module runs its own pass over the event and reuses the same
// patterns.
const SECRET_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
]);

const REDACTED = "[REDACTED]";

// The request headers the high-trust scrubber removes. `cookie` and
// `authorization` carry the session and the credential. The rest carry the
// caller IP address. The plan warns not to trust the SDK to gate these, so the
// scrubber removes them itself, so the high-trust level honors
// `sendDefaultPii: false` for the cookies, the credential, and the caller IP
// address regardless of the SDK default integrations.
const REMOVED_HIGH_TRUST_HEADERS = new Set<string>([
  "cookie",
  "authorization",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
  "x-client-ip",
  "cf-connecting-ip",
]);

// The name fragments that mark a credential-bearing header. The removed set
// above drops the session, the primary credential, and the caller IP address in
// full. The high-trust scrubber keeps every other request header for debug use,
// so it must still redact the value of a header that carries a secret under a
// non-standard name, for example `proxy-authorization`, `x-api-key`, or a
// vendor auth header such as `x-openclaw-auth`. The `auth` fragment matches any
// such header name, including `authorization`. The scrubber compares the
// lower-case header name against these fragments and redacts the value of any
// match, but it keeps the header name.
const SENSITIVE_HEADER_FRAGMENTS = [
  "auth",
  "api-key",
  "apikey",
  "api_key",
  "access-token",
  "session-token",
  "secret",
  "credential",
  "token",
] as const;

function isSensitiveHeaderName(lowerName: string): boolean {
  return SENSITIVE_HEADER_FRAGMENTS.some((fragment) => lowerName.includes(fragment));
}

// A guard against a hostile or accidental cycle. The event tree is shallow, so a
// cap of twenty keeps the high-trust debug data (breadcrumbs, contexts, and
// stack-frame local variables) while it stops runaway recursion.
const MAX_SCRUB_DEPTH = 20;

// Strip the credentials from a URL that appears anywhere inside a string. The
// pattern matches `scheme://userinfo@` and removes the `userinfo@` part, so a
// connection string such as `postgres://user:pass@host/db` becomes
// `postgres://host/db`. This mirrors the URL-credential stripping in
// `redact-sensitive.ts`, but it finds a URL inside surrounding prose (an
// exception message), which the whole-string parser there cannot.
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi;

function stripUrlCredentials(value: string): string {
  return value.replace(URL_CREDENTIALS_PATTERN, "$1");
}

// The patterns that find a bare credential inside a free-form string. The
// high-trust level keeps the exception message, the breadcrumbs, and the
// stack-frame local variables. A secret can appear there as a bare value with no
// denylist key around it, so the key walker cannot catch it. Each pattern
// redacts the credential in place and keeps the surrounding text. These patterns
// mirror the secret value patterns in `services/feedback-redaction.ts`. The URL
// credential strip stays a separate pass, because it keeps the host for debug
// use.
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ regex: RegExp; replacement: string }> = [
  // A PEM private-key or certificate block.
  { regex: /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g, replacement: REDACTED },
  // An HTTP Authorization credential: `Bearer <token>` or `Basic <base64>`. Keep
  // the scheme word so the reader still sees an auth header was present.
  { regex: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replacement: `$1 ${REDACTED}` },
  // A GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`).
  { regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  // A provider API key such as `sk-...` or `sk-ant-...`.
  { regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, replacement: REDACTED },
  // A Slack token. A bot, user, app-configuration, or refresh token starts with
  // `xox<type>-`. An app-level token starts with `xapp-`.
  { regex: /\b(?:xox[abprse]|xapp)-[A-Za-z0-9-]{8,}/g, replacement: REDACTED },
  // A JSON Web Token. It always starts with the base64url header prefix `eyJ`.
  {
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    replacement: REDACTED,
  },
  // A `key=value` or `key: value` secret assignment inside prose.
  {
    regex:
      /\b(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|private[-_]?key|session[-_]?token)\s*[:=]\s*([^\s,;'"]+)/gi,
    replacement: `$1=${REDACTED}`,
  },
];

/**
 * Scrub the secrets from a single string value. It strips the URL credentials
 * and then redacts every bare credential pattern. It returns a new string; it
 * never mutates the input. The scrubber runs it on every string it keeps, in
 * both trust levels.
 */
function scrubSecretString(value: string): string {
  let out = stripUrlCredentials(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern.regex, pattern.replacement);
  }
  return out;
}

/**
 * Run the secret-redaction pass over any value. It redacts the value of a
 * secret-denylist key, strips the credentials from a URL inside any string, and
 * redacts a bare credential pattern inside any string. It returns a new value;
 * it never mutates the input. It runs in both trust levels. Paperclip must never
 * send its own secrets to a third party.
 */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return undefined;
  if (typeof value === "string") return scrubSecretString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSecrets(entry, depth + 1);
  }
  return out;
}

/** Read the typed `CaptureContext` fields that a capture call stashed on the event. */
function extractCaptureContext(event: Record<string, unknown>): Record<string, unknown> {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  const raw = contexts?.[CAPTURE_CONTEXT_KEY] as Record<string, unknown> | undefined;
  const kept: Record<string, unknown> = {};
  if (!raw) return kept;
  for (const field of CAPTURE_CONTEXT_FIELDS) {
    if (raw[field] !== undefined) kept[field] = raw[field];
  }
  return kept;
}

/**
 * The low-trust strategy. It returns a new event that carries only an
 * allowlisted field set: the minimal envelope keys, the redacted exception, and
 * the typed `CaptureContext` fields. It drops the SDK auto-captured `request`,
 * `user`, `extra`, `breadcrumbs`, and `contexts` structures in full, every tag,
 * and every stack-frame local-variable map. It redacts the exception message and
 * removes the serialized error properties.
 */
function scrubLowTrust(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Copy only the minimal envelope keys that carry no personal data. The SDK
  // needs these for a well-formed event.
  for (const key of ["event_id", "timestamp", "platform", "level", "environment", "release", "sdk"]) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  // Keep the exception, but drop the stack-frame local variables and redact the
  // message and every remaining string.
  const exception = event.exception as
    | { values?: Array<Record<string, unknown>> }
    | undefined;
  if (exception?.values) {
    out.exception = {
      values: exception.values.map((value) => {
        const stacktrace = value.stacktrace as
          | { frames?: Array<Record<string, unknown>> }
          | undefined;
        const frames = stacktrace?.frames?.map((frame) => {
          // Drop the local-variable map. Keep the source-location fields.
          const { vars: _vars, ...rest } = frame;
          return redactSecrets(rest) as Record<string, unknown>;
        });
        return {
          type: value.type,
          value: typeof value.value === "string" ? scrubSecretString(value.value) : value.value,
          ...(frames ? { stacktrace: { frames } } : {}),
          ...(value.mechanism ? { mechanism: redactSecrets(value.mechanism) } : {}),
        };
      }),
    };
  }
  // Keep only the allowlisted, secret-scrubbed capture context.
  const capture = redactSecrets(extractCaptureContext(event)) as Record<string, unknown>;
  if (Object.keys(capture).length > 0) {
    out.contexts = { [CAPTURE_CONTEXT_KEY]: capture };
  }
  return out;
}

/**
 * The high-trust strategy. It keeps the SDK-captured `request` metadata, the
 * `breadcrumbs`, the `contexts`, and the stack-frame local variables. It removes
 * the identity fields that `sendDefaultPii: false` must keep off: the `user`
 * object, the cookies, the authorization and cookie headers, and the caller IP
 * address. It also drops `sdkProcessingMetadata`, which holds the raw request
 * with the authorization header and the cookies. Then it runs the
 * secret-redaction pass over every remaining string value.
 */
function scrubHighTrust(event: Record<string, unknown>): Record<string, unknown> {
  // Work on a shallow structural copy so the removals do not mutate the input.
  const out: Record<string, unknown> = { ...event };
  // The user identity and the caller IP address (`user.ip_address`) leave with
  // the whole user object.
  delete out.user;
  // `sdkProcessingMetadata` carries the raw normalized request, including the
  // authorization header and the cookies. It is internal SDK metadata; drop it.
  delete out.sdkProcessingMetadata;

  const request = out.request as Record<string, unknown> | undefined;
  if (request) {
    const nextRequest: Record<string, unknown> = { ...request };
    // Remove the cookies and the caller IP address env entry.
    delete nextRequest.cookies;
    delete nextRequest.env;
    const headers = nextRequest.headers as Record<string, unknown> | undefined;
    if (headers) {
      const nextHeaders: Record<string, unknown> = {};
      for (const [name, headerValue] of Object.entries(headers)) {
        const lowerName = name.toLowerCase();
        // Remove the cookie, authorization, and caller-IP header entries.
        if (REMOVED_HIGH_TRUST_HEADERS.has(lowerName)) continue;
        // Redact the value of any other credential-bearing header, such as a
        // proxy credential or an API key. Keep the header name for debug use.
        if (isSensitiveHeaderName(lowerName)) {
          nextHeaders[name] = REDACTED;
          continue;
        }
        nextHeaders[name] = headerValue;
      }
      nextRequest.headers = nextHeaders;
    }
    out.request = nextRequest;
  }
  // Run the secret pass over the whole remaining event. It redacts a secret
  // under a denylist key and strips URL credentials from every string.
  return redactSecrets(out) as Record<string, unknown>;
}

/**
 * The `beforeSend` scrubber for the given trust level. It is fail-closed: if it
 * throws, it returns `null`, which drops the whole event. An un-redacted event
 * never reaches transport because the scrubber failed.
 */
function makeBeforeSend(
  level: SentryTrustLevel,
): (event: Record<string, unknown>) => Record<string, unknown> | null {
  return (event: Record<string, unknown>): Record<string, unknown> | null => {
    try {
      return level === "high" ? scrubHighTrust(event) : scrubLowTrust(event);
    } catch {
      // Fail closed. Drop the event rather than send it un-redacted.
      return null;
    }
  };
}

/**
 * Build the `Sentry.init` options for the active trust level. Both levels set
 * `sendDefaultPii: false` and `skipOpenTelemetrySetup: true`, so Sentry never
 * takes over the OpenTelemetry traces and never sends the cookies, the caller IP
 * address, or the user identity by default. Both levels register the `beforeSend`
 * scrubber. The high-trust level adds the local variables and the SDK default
 * integrations.
 */
function buildInitOptions(activeDsn: string, level: SentryTrustLevel): Record<string, unknown> {
  const common: Record<string, unknown> = {
    dsn: activeDsn,
    skipOpenTelemetrySetup: true,
    sendDefaultPii: false,
    beforeSend: makeBeforeSend(level),
  };
  if (level === "high") {
    return {
      ...common,
      includeLocalVariables: true,
    };
  }
  return {
    ...common,
    includeLocalVariables: false,
    defaultIntegrations: false,
  };
}

/**
 * Import `@sentry/node` on the enabled path only and initialize it with the
 * level profile. A missing package or a failed import must not crash the server:
 * it warns once, without the DSN value, and leaves Sentry off.
 */
async function bootstrapSentry(activeDsn: string, level: SentryTrustLevel): Promise<void> {
  try {
    // @ts-ignore optional dependency; installed only when the operator opts in.
    const Sentry = (await import("@sentry/node")) as unknown as SentryModule;
    Sentry.init(buildInitOptions(activeDsn, level));
    sentryApi = Sentry;
    enabled = true;
  } catch (err) {
    // The package is not installed, or the import failed. Keep booting without
    // error reports. Never print the DSN value.
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] SENTRY_DSN is set but @sentry/node is not installed. " +
        "Install @sentry/node to enable error reports.",
      err,
    );
  }
}

/**
 * Resolves once Sentry has initialized (or once the bootstrap failed and logged,
 * or immediately when the feature is off). Await it before the server starts, so
 * error capture does not depend on incidental timing.
 */
export const sentryReady: Promise<void> = dsn
  ? bootstrapSentry(dsn, trustLevel)
  : Promise.resolve();

/** True when Sentry loaded and initialized. False on the disabled or absent path. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/** The active trust level, read once at module evaluation. */
export function sentryTrustLevel(): SentryTrustLevel {
  return trustLevel;
}

/** True when the high-trust level is on. Used for the bootstrap warning. */
export function isHighTrust(): boolean {
  return trustLevel === "high";
}

/**
 * The startup warning for the high-trust level. It returns the warning text when
 * the high-trust level is on, and `undefined` in the low-trust level. The text
 * names the data categories that now cross the boundary and states that the
 * cookies, the caller IP address, and the user identity stay off. It never
 * prints the DSN value. The bootstrap logs it once at start.
 */
export function highTrustWarning(): string | undefined {
  if (trustLevel !== "high") return undefined;
  return (
    "[paperclip] SENTRY_TRUST_LEVEL=high. When SENTRY_DSN is set, Sentry receives " +
    "richer debug data: the stack-frame local variables, the breadcrumbs, the error " +
    "context, and the request metadata. sendDefaultPii is false, so the cookies, the " +
    "caller IP address, and the user identity stay off. Set SENTRY_TRUST_LEVEL=low or " +
    "unset it to return to the minimal level."
  );
}

/**
 * Capture an error to Sentry with a narrow, typed context. It never throws. It
 * returns the event id, or `undefined` when Sentry is off. The `beforeSend`
 * scrubber (Phase 2) is the egress contract that redacts the event.
 */
export function captureException(error: unknown, context?: CaptureContext): string | undefined {
  if (!enabled || !sentryApi) return undefined;
  try {
    const captureContext =
      context === undefined ? undefined : { contexts: { paperclip_capture: context } };
    return sentryApi.captureException(error, captureContext);
  } catch {
    // Observability must never change control flow.
    return undefined;
  }
}

/**
 * Flush buffered events before process exit. It resolves even when Sentry is
 * off. Repeated calls share one promise, so concurrent shutdown paths flush
 * once.
 */
export function flushSentry(timeoutMs = 2000): Promise<void> {
  flushPromise ??= (async () => {
    await sentryReady;
    if (!enabled || !sentryApi) return;
    try {
      await sentryApi.flush(timeoutMs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry flush failed", err);
    }
  })();
  return flushPromise;
}
