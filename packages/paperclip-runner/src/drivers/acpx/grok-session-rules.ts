/**
 * Grok Build binds its model only when a native session opens: it has no
 * standard model setter. It also reads task instructions from `session/new`
 * `_meta.rules`, not from ACPX's Claude-shaped session metadata. Write both on
 * the wire for every session open, whether or not an effort is selected; the
 * effort guard then adds the effort and checks the same model.
 */
export function createGrokSessionOpenGuard(options: { rules: string; model: string }): (direction: "inbound" | "outbound", value: unknown) => void {
  return (direction, value) => {
    const message = record(value);
    if (direction !== "outbound") return;
    if (message.method === "session/new") {
      message.params = { ...record(message.params), _meta: { rules: options.rules, modelId: options.model } };
    } else if (message.method === "session/load" || message.method === "session/resume") {
      const params = record(message.params);
      message.params = { ...params, _meta: { ...record(params._meta), modelId: options.model } };
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
