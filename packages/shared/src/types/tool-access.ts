export type CompanyToolSource = "paperclip_builtin" | "adapter_toolset" | "mcp_tool" | "skill";
export type CompanyToolRisk = "read" | "write" | "admin" | "secret";
export type ToolAccessMode = "off" | "read" | "write" | "admin";

export interface CompanyTool {
  id: string;
  companyId: string;
  key: string;
  label: string;
  description: string | null;
  source: CompanyToolSource;
  adapter: string;
  serverKey: string | null;
  toolName: string | null;
  risk: CompanyToolRisk;
  supportedModes: ToolAccessMode[];
  render: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentToolGrant {
  id: string;
  companyId: string;
  agentId: string;
  toolId: string;
  mode: ToolAccessMode;
  grantedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolAccessMatrix {
  tools: CompanyTool[];
  grants: AgentToolGrant[];
}
