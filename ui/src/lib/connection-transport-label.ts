import type { ToolConnection } from "@paperclipai/shared";

export function connectionTransportLabel(transport: ToolConnection["transport"]): string {
  if (transport === "mcp_remote") return "Remote HTTP";
  if (transport === "connector") return "Outbound connector";
  if (transport === "local_stdio") return "Local command";
  return "Unknown";
}

export function auditTransportLabel(transport: string): string {
  return transport === "mcp_remote" || transport === "local_stdio" ? connectionTransportLabel(transport) : transport;
}
