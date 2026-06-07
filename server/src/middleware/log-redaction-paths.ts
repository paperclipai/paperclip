/**
 * Header paths that must never be persisted to any log transport.
 *
 * pino applies `redact` in the main thread BEFORE the serialized value reaches
 * stdout or the file transport, so a path listed here is censored on *all*
 * targets (the file `server.log` included). Keep this list focused on
 * credential- and session-bearing headers.
 *
 * Why each entry exists:
 * - `authorization` / `proxy-authorization`: bearer tokens & basic-auth creds.
 * - `cookie` / `set-cookie`: session identifiers — leaking these enables
 *   session hijacking, which is the SOF-100 finding (cookies were written in
 *   cleartext to `server.log` because only `authorization` was redacted).
 * - `x-csrf-token` / `x-xsrf-token`: CSRF tokens paired with the session.
 * - `x-api-key`: some clients pass API keys outside the Authorization header.
 *
 * The `headers.*` duplicates (without the `req.` prefix) are defensive: if a
 * serializer ever emits headers without the `req` envelope, the sensitive
 * values are still censored.
 *
 * See SOF-100.
 */
export const HTTP_LOG_REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["proxy-authorization"]',
  'headers["x-csrf-token"]',
  'headers["x-xsrf-token"]',
  'headers["x-api-key"]',
];
