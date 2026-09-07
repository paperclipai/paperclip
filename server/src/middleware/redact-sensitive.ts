// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  // Provider setup payloads deliberately group all durable authentication
  // material under `credentials`. Redact the whole subtree instead of trying
  // to keep an ever-changing allowlist of provider-specific field names in
  // sync with every connector.
  "credential",
  "credentials",
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  // Secret creation/update bodies use a generic `value` field. Failure logs
  // must prefer losing that diagnostic value over persisting credential
  // material. `token` is likewise ambiguous but frequently credential-bearing.
  "value",
  "token",
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
  // Defense in depth for legacy, malformed, or provider-specific payloads
  // that place a credential outside the standard `credentials` envelope.
  "app_secret",
  "appsecret",
  "application_secret",
  "applicationsecret",
  "bot_token",
  "bottoken",
  "secret_token",
  "secrettoken",
  "signing_secret",
  "signingsecret",
  "webhook_secret",
  "webhooksecret",
  "paperclip_capability",
  // The Claude setup-token login fields. `browserCode` carries the one-time
  // sign-in code and `authorization_code` carries the OAuth code; neither may
  // reach a log line.
  "browsercode",
  "authorization_code",
  "authorizationcode",
  // The workspace login handoff ticket (PAP-17572). It is a signed bearer
  // credential carried as a query parameter, so it must never reach a log line
  // even though the exchange itself answers 302.
  "ticket",
  // Not secrets Paperclip holds, but attacker-authored prose: an OAuth provider
  // controls `error_description` / `error_uri` on the callback query string, and
  // `customProps` copies the whole query into 4xx log lines. Paperclip maps the
  // `error` code to its own copy instead of reflecting these, so they have no
  // debugging value here either (PAP-17108).
  "error_description",
  "errordescription",
  "error_uri",
  "erroruri",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const URLISH_KEYS = new Set<string>([
  "href",
  "locator",
  "source",
  "source_locator",
  "sourcelocator",
  "source_url",
  "sourceurl",
  "uri",
  "url",
  // The Claude setup-token login URL. A structured `loginUrl` that reaches a log
  // sink keeps its origin and path only; the OAuth query, fragment, and any
  // credentials are stripped (SR-5 backstop).
  "loginurl",
  "login_url",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isUrlishKey(key: string): boolean {
  return URLISH_KEYS.has(key.toLowerCase());
}

export function stripSecretBearingUrlParts(value: string): string {
  const suffixStart = value.search(/[?#]/);
  const withoutQueryOrFragment =
    suffixStart === -1 ? value : value.slice(0, suffixStart);

  try {
    const url = new URL(withoutQueryOrFragment);
    if (!url.username && !url.password && suffixStart === -1) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Request URLs are normally origin-form paths rather than absolute URLs.
    // They still need the same query/fragment policy as URL-valued payloads.
    return withoutQueryOrFragment;
  }
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof entry === "string" && isUrlishKey(key)) {
      out[key] = stripSecretBearingUrlParts(entry);
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}

function collectSensitiveStringValuesInto(
  value: unknown,
  values: Set<string>,
  collectAll: boolean,
  depth: number,
): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (collectAll && value.length > 0) values.add(value);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSensitiveStringValuesInto(entry, values, collectAll, depth + 1);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveStringValuesInto(
      entry,
      values,
      collectAll || isSensitiveKey(key),
      depth + 1,
    );
  }
}

/** Collects submitted credential strings without exposing them to callers' logs. */
export function collectSensitiveStringValues(value: unknown): string[] {
  const values = new Set<string>();
  collectSensitiveStringValuesInto(value, values, false, 0);
  return [...values];
}

function encodedSensitiveVariants(values: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    const normalizedValues = new Set([value, value.trim()]);
    for (const normalizedValue of normalizedValues) {
      if (normalizedValue.length === 0) continue;
      variants.add(normalizedValue);
      const json = JSON.stringify(normalizedValue);
      if (json.length >= 2) variants.add(json.slice(1, -1));
      try {
        const urlEncoded = encodeURIComponent(normalizedValue);
        variants.add(urlEncoded);
        variants.add(urlEncoded.replaceAll("%20", "+"));
      } catch {
        // A lone UTF-16 surrogate is not URI-encodable. The raw and JSON-escaped
        // forms are still covered, and error handling must never throw again
        // while trying to sanitize malformed input.
      }
    }
  }
  return [...variants]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

/**
 * Redacts sensitive-shaped fields, then removes submitted credential values
 * wherever an upstream validator/provider echoed them into otherwise-safe
 * response prose.
 */
export function redactSensitiveValueOccurrences(
  value: unknown,
  sensitiveValues: readonly string[],
): unknown {
  const variants = encodedSensitiveVariants(sensitiveValues);
  const redacted = redactSensitive(value);

  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return undefined;
    if (typeof entry === "string") {
      return variants.reduce(
        (text, sensitiveValue) => text.replaceAll(sensitiveValue, REDACTED),
        entry,
      );
    }
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry))
      return entry.map((item) => visit(item, depth + 1));
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).map(([key, item]) => [
        key,
        visit(item, depth + 1),
      ]),
    );
  };

  return visit(redacted, 0);
}
