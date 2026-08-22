export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  // Auth-shaped headers the server does not accept as credentials. They are
  // still logged with the request, including on the rejected response, so a
  // credential a caller put in the wrong header would otherwise be written
  // out in clear text.
  'req.headers["x-api-key"]',
  'req.headers["api-key"]',
  'req.headers["x-auth-token"]',
] as const;
