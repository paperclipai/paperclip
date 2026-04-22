import type { AgentEnvConfig } from "./secrets.js";
import type { McpServerHealthStatus, McpServerTransport } from "../constants.js";

export interface McpServer {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  transport: McpServerTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  env: AgentEnvConfig;
  enabled: boolean;
  lastHealthStatus: McpServerHealthStatus;
  lastHealthcheckAt: Date | null;
  lastDiscoveryAt: Date | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpServerRequest {
  name: string;
  slug: string;
  description?: string | null;
  transport: McpServerTransport;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  env?: AgentEnvConfig;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateMcpServerRequest {
  name?: string;
  slug?: string;
  description?: string | null;
  transport?: McpServerTransport;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  env?: AgentEnvConfig;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}
