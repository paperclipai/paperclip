/**
 * Grok Build reads task instructions from `session/new` `_meta.rules`, not
 * from ACPX's Claude-shaped session metadata. Replace that metadata on the
 * wire before the effort guard binds model and effort into it.
 */
export function createGrokSessionRulesGuard(rules: string): (direction: "inbound" | "outbound", value: unknown) => void {
  return (direction, value) => {
    const message = record(value);
    if (direction !== "outbound" || message.method !== "session/new") return;
    message.params = { ...record(message.params), _meta: { rules } };
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
