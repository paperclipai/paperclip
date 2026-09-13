/** Keep only execution identity fields; never persist credentials or runner objects. */
export function serializeSessionExecutionIdentity(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { transport: "invalid" };
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["transport", "host", "username", "remoteCwd", "providerKey", "environmentId", "leaseId", "providerLeaseId"]) {
    if (typeof record[key] === "string") result[key] = record[key];
  }
  if (typeof record.port === "number" && Number.isFinite(record.port)) result.port = record.port;
  // Malformed remote state must not become an empty, local-compatible identity.
  return Object.keys(result).length > 0 ? result : { transport: "invalid" };
}
