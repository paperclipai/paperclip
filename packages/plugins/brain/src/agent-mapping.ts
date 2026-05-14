/**
 * Map a Paperclip agent UUID to a Brain ACL key (e.g. "CEO", "CTO", "DSB").
 * Falls back to the UUID itself so ACL rows can be keyed by UUID directly if
 * the operator prefers that convention. If `uuid` is missing, returns "unknown"
 * so the MCP server's default-deny applies.
 */
export function mapAgentId(
  uuid: string | undefined,
  map: Record<string, string>,
): string {
  if (!uuid) return "unknown";
  return map[uuid] ?? uuid;
}

export function parseAgentMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
      return result;
    }
  } catch {
    // ignored — return empty map
  }
  return {};
}
