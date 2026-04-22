import type { McpServerCatalogSnapshot } from "./mcp-server-catalog.js";

export interface TestMcpServerRequest {
  workspacePath?: string | null;
  timeoutSec?: number | null;
}

export interface McpServerDiscoveryResult {
  ok: boolean;
  mcpServerId: string;
  snapshot: McpServerCatalogSnapshot;
  logs: string[];
}
