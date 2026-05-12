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
  "token",
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

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}
