/**
 * A bounded producer-owned explanation of an external connection failure.
 * This changes error reporting only: it never proves remote acceptance,
 * authorizes a retry, or turns a failed run into a success.
 */
const gitReasons = [
  "authentication_failed", "repository_unavailable", "invalid_remote",
  "dns_failure", "connection_refused", "network_unreachable", "connection_reset",
  "connection_timeout", "tls_failure", "rate_limited", "remote_unavailable",
] as const;
const hermesConfigurationReasons = [
  "endpoint_missing", "endpoint_invalid", "insecure_transport", "credentials_missing",
] as const;
const hermesRequestReasons = [
  "authentication_failed", "endpoint_not_found", "rate_limited", "remote_unavailable",
  "connection_refused", "dns_failure", "network_unreachable", "connection_reset",
  "connection_timeout", "tls_failure",
] as const;

export type GitConnectionFailure = {
  schemaVersion: 1;
  provider: "git";
  operation: "clone";
  reason: typeof gitReasons[number];
};

export type ConnectionFailure = GitConnectionFailure | {
  schemaVersion: 1;
  provider: "hermes_gateway";
} & ({
  operation: "configuration";
  reason: typeof hermesConfigurationReasons[number];
} | {
  operation: "create_run";
  reason: typeof hermesRequestReasons[number];
}) | {
  schemaVersion: 1;
  provider: "mcp_http";
  operation: "discover_tools";
  reason: typeof hermesRequestReasons[number];
};

/** Unknown versions, combinations and extra payload fields remain reportable. */
export function readConnectionFailure(value: unknown): ConnectionFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !keys.every((key) => ["schemaVersion", "provider", "operation", "reason"].includes(key)) ||
      record.schemaVersion !== 1 || typeof record.reason !== "string") return null;
  let reasons: readonly string[];
  if (record.provider === "git" && record.operation === "clone") reasons = gitReasons;
  else if (record.provider === "hermes_gateway" && record.operation === "configuration") reasons = hermesConfigurationReasons;
  else if (record.provider === "hermes_gateway" && record.operation === "create_run") reasons = hermesRequestReasons;
  else if (record.provider === "mcp_http" && record.operation === "discover_tools") reasons = hermesRequestReasons;
  else return null;
  if (!reasons.includes(record.reason)) return null;
  return { schemaVersion: 1, provider: record.provider, operation: record.operation, reason: record.reason } as ConnectionFailure;
}
