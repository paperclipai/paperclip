import type { EnvBinding } from "./secrets.js";

export type McpTransportType = "stdio" | "sse" | "streamable-http";

export interface McpServer {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  transportType: McpTransportType;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, EnvBinding>;
  env: Record<string, EnvBinding>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentMcpServer {
  agentId: string;
  mcpServerId: string;
  companyId: string;
  createdAt: Date;
}

/** MCP server config with all secret refs resolved to plain values, ready for runtime injection. */
export interface ResolvedMcpServer {
  name: string;
  transportType: McpTransportType;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
}
