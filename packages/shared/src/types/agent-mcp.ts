import type { McpServerStatus, McpTransport } from "../constants.js";

/**
 * A per-agent installed MCP server (issue #2). Durable record of a board-approved
 * server delivered into the agent runtime. Secret values are not stored here;
 * `envBindings` carry secret references resolved at run time.
 */
export interface AgentMcpServer {
  id: string;
  companyId: string;
  agentId: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  config: Record<string, unknown>;
  envBindings: Record<string, unknown>;
  status: McpServerStatus;
  sourceApprovalId: string | null;
  createdByActorType: string | null;
  createdByActorId: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}

/**
 * The resolved shape injected into a run context and rendered by the claude_local
 * adapter into `.mcp.json`. Secrets are already resolved into `env` (stdio) or
 * `headers` (http).
 */
export interface RuntimeMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
