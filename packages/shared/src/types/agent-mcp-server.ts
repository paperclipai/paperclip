import type { McpServerBindingMode } from "../constants.js";
import type { McpServer } from "./mcp-server.js";
import type { McpServerCatalogSnapshot } from "./mcp-server-catalog.js";

export interface AgentMcpServerBinding {
  companyId: string;
  agentId: string;
  mcpServerId: string;
  bindingMode: McpServerBindingMode;
  enabled: boolean;
  allowedTools: string[];
  bindingAuthority: string;
  toolClearances: Record<string, string>;
  defaultMinUserRole: string;
  autonomousAllowed: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BindAgentMcpServerRequest {
  mcpServerId: string;
  bindingMode?: McpServerBindingMode;
  enabled?: boolean;
  allowedTools?: string[];
}

export interface UpdateAgentMcpServerBindingRequest {
  bindingMode?: McpServerBindingMode;
  enabled?: boolean;
  allowedTools?: string[];
}

export interface AgentMcpServerBindingDetail extends AgentMcpServerBinding {
  server: McpServer;
  latestSnapshot: McpServerCatalogSnapshot | null;
}
