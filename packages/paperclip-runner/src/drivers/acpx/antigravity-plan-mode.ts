import { canonicalRunnerToolName } from "../runner-tool-bridge.js";

/** Antigravity 1.5.2 has no plan session mode (only default, auto_edit and
 * yolo), and its native `/plan` command does not reach the harness intact: the
 * pinned SDK hands the harness the command name as
 * "BuiltinSlashCommandName.PLAN", which the harness shows the model as text and
 * never treats as planning mode (observed live on 1.5.2). Paperclip's Plan mode
 * therefore keeps the run read-only here, at the provider's permission prompt.
 *
 * Allowed, and nothing else (fail closed):
 * - the 1.5.2 server's built-in research tools, named by the exact
 *   `Run <tool>?` title its permission prompt uses for non-MCP tools, when the
 *   reported kind also matches that tool's kind (tools.py infer_tool_kind);
 * - tools the runner's own Paperclip bridge registered for this run, on the
 *   runner-owned server named `paperclip`. The Paperclip server applies its
 *   Plan-mode rules to these, and the plan document is written through them.
 * The provider's kind alone never grants a read, and no other MCP server is
 * trusted, runner-owned or not. */
export const ANTIGRAVITY_PAPERCLIP_MCP_SERVER = "paperclip";

const RESEARCH_TOOL_KINDS: ReadonlyMap<string, string> = new Map([
  ["view_file", "read"], ["read_file", "read"], ["client_view_file", "read"],
  ["grep_search", "search"], ["find_by_name", "search"], ["list_dir", "search"],
  ["search_directory", "search"], ["list_directory", "search"], ["find_file", "search"],
  ["search_web", "search"], ["read_url_content", "fetch"],
]);

export interface AntigravityPlanModePolicy {
  /** The run's `paperclip` MCP server is the runner-owned Paperclip bridge. */
  paperclipServerOwned: boolean;
  /** Canonical names of the tools that bridge registered for this run. */
  paperclipTools: ReadonlySet<string>;
}

export function antigravityPlanModeAllows(request: { raw?: unknown }, policy: AntigravityPlanModePolicy): boolean {
  const toolCall = record(record(request.raw).toolCall);
  const meta = record(toolCall._meta);
  // Any metadata bag sends the call down the strict MCP path.
  if (toolCall._meta !== undefined && toolCall._meta !== null) {
    const mcp = record(meta.mcp);
    return meta.is_mcp_tool_call === true && policy.paperclipServerOwned
      && mcp.server === ANTIGRAVITY_PAPERCLIP_MCP_SERVER && typeof mcp.tool === "string"
      && policy.paperclipTools.has(canonicalRunnerToolName(mcp.tool));
  }
  const name = typeof toolCall.title === "string" ? /^Run ([a-z_]+)\?$/.exec(toolCall.title)?.[1] : undefined;
  return name !== undefined && RESEARCH_TOOL_KINDS.get(name) === toolCall.kind;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
