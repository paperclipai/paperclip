import type { ToolRiskLevel } from "@paperclipai/shared";

export function enterpretRisk(tool: { name: string }): ToolRiskLevel | null {
  const name = tool.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase().replace(/[:._-]+/g, "-");
  // This tool advertises readOnlyHint, but Cypher can mutate the graph and
  // live qualification has not established a read-only execution boundary.
  return name === "run-graph-query" ? "write" : null;
}
