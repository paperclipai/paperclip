/** Antigravity 1.5.2 has no plan session mode (only default, auto_edit and
 * yolo), and its native `/plan` command does not reach the harness intact: the
 * pinned SDK hands the harness the command name as
 * "BuiltinSlashCommandName.PLAN", which the harness shows the model as text and
 * never treats as planning mode (observed live on 1.5.2). Paperclip's Plan mode
 * therefore keeps the run read-only here, at the provider's permission prompt.
 *
 * Reads, searches and page reads stay available for research. Paperclip's own
 * tools stay available too: the Paperclip server applies Plan-mode rules to
 * them, and the plan document is written through them. Everything else,
 * including file edits and terminal commands, is refused. */
const RESEARCH_KINDS = new Set(["read", "search", "fetch"]);

export function antigravityPlanModeAllows(request: { raw?: unknown }, runnerOwnedMcpServerNames: ReadonlySet<string>): boolean {
  const toolCall = record(record(request.raw).toolCall);
  const meta = record(toolCall._meta);
  if (meta.is_mcp_tool_call !== undefined || meta.mcp !== undefined) {
    const server = record(meta.mcp).server;
    return meta.is_mcp_tool_call === true && typeof server === "string" && runnerOwnedMcpServerNames.has(server);
  }
  return typeof toolCall.kind === "string" && RESEARCH_KINDS.has(toolCall.kind);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
