import type { ToolRiskLevel } from "@paperclipai/shared";

// Reviewed against Braintrust's hosted MCP tool reference on 2026-10-21:
// https://www.braintrust.dev/docs/integrations/developer-tools/mcp#tools
// Exact names make additions and renames require review. In particular, test
// and evaluation tools can execute code or consume model credits without
// changing a source trace, so readOnlyHint cannot make them reads.
const READ_TOOLS = new Set([
  "sql_query",
  "infer_schema",
  "summarize_experiment",
  "list_recent_objects",
  "resolve_object",
  "generate_permalink",
  "lookup_users",
  "lookup_api_keys",
  "get_trace_work_items",
  "search_patterns",
  "generate_monitor_chart",
  "list_monitoring_views",
  "get_monitoring_view",
  "list_automations",
  "list_slack_channels",
  "get_project_settings",
  "search_docs",
  "load_braintrust_skill",
]);

const DESTRUCTIVE_TOOLS = new Set([
  // One action supports insertion, replacement, and permanent deletion.
  "edit_dataset_rows",
  // Activating an existing automation can apply retention or deliver data.
  "set_automation_status",
]);

export function braintrustRisk(tool: {
  name: string;
  annotations?: Record<string, unknown>;
}): ToolRiskLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true
    || DESTRUCTIVE_TOOLS.has(tool.name)) return "destructive";
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
  return READ_TOOLS.has(tool.name) ? "read" : "write";
}
