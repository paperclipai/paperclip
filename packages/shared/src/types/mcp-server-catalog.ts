import type { McpServerDiscoveryStatus } from "../constants.js";

export interface McpServerCatalogTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface McpServerCatalogResource {
  uri: string;
  name: string | null;
  description: string | null;
  mimeType: string | null;
  raw: Record<string, unknown>;
}

export interface McpServerCatalogPrompt {
  name: string;
  title: string | null;
  description: string | null;
  arguments: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}

export interface McpServerCatalogSnapshot {
  id: string;
  companyId: string;
  mcpServerId: string;
  status: McpServerDiscoveryStatus;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  summary: string | null;
  tools: McpServerCatalogTool[];
  resources: McpServerCatalogResource[];
  prompts: McpServerCatalogPrompt[];
  serverInfo: Record<string, unknown>;
  error: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}
