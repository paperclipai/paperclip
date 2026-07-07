export type AgentBaseDetailView = "dashboard" | "instructions" | "configuration" | "skills" | "runs" | "budget";
export type AgentPluginDetailView = `plugin:${string}`;
export type AgentDetailView = AgentBaseDetailView | AgentPluginDetailView;

export function isAgentPluginDetailView(value: string | null): value is AgentPluginDetailView {
  return typeof value === "string" && value.startsWith("plugin:");
}

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (isAgentPluginDetailView(value)) return value;
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "configure" || value === "configuration") return "configuration";
  if (value === "skills") return "skills";
  if (value === "budget") return "budget";
  if (value === "runs") return value;
  return "dashboard";
}
