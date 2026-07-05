import { redactEventPayload } from "../redaction.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Redact plain secret-bearing values in a single MCP server config for API
 * responses; secret_refs pass through. Generic sanitization flattens the whole
 * `auth` object (its key matches the sensitive-key pattern), so a safe
 * structural summary is rebuilt from the original: consumers need auth type +
 * OAuth connection status, never token material.
 */
export function sanitizeMcpServerConfigForResponse(config: unknown): Record<string, unknown> {
  const record = asRecord(config) ?? {};
  const sanitized = (redactEventPayload({ server: record })?.server ?? {}) as Record<string, unknown>;
  const originalAuth = asRecord(record.auth);
  if (originalAuth?.type === "oauth") {
    sanitized.auth = {
      type: "oauth",
      secretId: typeof originalAuth.secretId === "string" ? originalAuth.secretId : null,
      connected: typeof originalAuth.secretId === "string" && originalAuth.secretId.length > 0,
    };
  } else if (originalAuth?.type === "bearer") {
    const token = asRecord(originalAuth.token);
    sanitized.auth = {
      type: "bearer",
      token:
        token?.type === "secret_ref" && typeof token.secretId === "string"
          ? {
              type: "secret_ref",
              secretId: token.secretId,
              ...(token.version !== undefined ? { version: token.version } : {}),
            }
          : { type: "plain", value: "***REDACTED***" },
    };
  }
  return sanitized;
}

/** Sanitize a whole `mcpServers` record keyed by server name. */
export function sanitizeMcpServersForResponse(mcpServers: unknown): Record<string, unknown> {
  const record = asRecord(mcpServers) ?? {};
  const sanitized: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(record)) {
    sanitized[name] = sanitizeMcpServerConfigForResponse(server);
  }
  return sanitized;
}
