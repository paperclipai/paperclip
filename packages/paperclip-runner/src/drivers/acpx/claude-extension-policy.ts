const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function enforceClaudeExtensionPolicy(direction: "inbound" | "outbound", message: unknown): void {
  if (direction !== "outbound") return;
  const request = record(message);
  if (!["session/new", "session/load", "session/resume", "session/fork"].includes(String(request.method))) return;
  const params = record(request.params);
  const meta = record(params._meta);
  const claude = record(meta.claudeCode);
  const options = record(claude.options);
  request.params = { ...params, _meta: { ...meta, claudeCode: { ...claude, options: {
    ...options, managedSettings: { ...record(options.managedSettings), strictKnownMarketplaces: [{ source: "skills-dir" }] },
  } } } };
}
