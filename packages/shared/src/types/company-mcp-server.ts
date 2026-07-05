import type { McpServerConfig } from "./mcp.js";

/**
 * Company-level MCP server catalog entry (mirrors CompanySkill). Servers are
 * defined once per company; agents opt in by name via the
 * `mcpServerRefs: string[]` key on their adapterConfig.
 */
export interface CompanyMcpServer {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  /** Sanitized in API responses: plain sensitive values are redacted. */
  config: McpServerConfig;
  enabled: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyMcpServerUsageAgent {
  id: string;
  name: string;
  title: string | null;
  status: string;
}

export interface CompanyMcpServerListItem extends CompanyMcpServer {
  attachedAgentCount: number;
  /** True when the server has a brokered OAuth connection. */
  oauthConnected: boolean;
}

export interface CompanyMcpServerDetail extends CompanyMcpServerListItem {
  usedByAgents: CompanyMcpServerUsageAgent[];
}

/** Per-agent MCP enablement snapshot (mirrors AgentSkillSnapshot, config-only). */
export interface AgentMcpServersSnapshot {
  /** Catalog names the agent has enabled (adapterConfig.mcpServerRefs). */
  desiredMcpServers: string[];
  /** Catalog names referenced by the agent that no longer exist. */
  missing: string[];
}
