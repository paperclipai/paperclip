import type { McpServerBindingMode } from "../constants.js";

// Merged plugin + MCP tool surface for one agent (NEO-286 D2-4).
//
// The index is deliberately compact — no JSON input schemas inline — so an
// agent can load its full tool surface once at init without blowing up its
// context window. Schemas are fetched on demand per tool (code-execution
// shape), and execution is server-side through the control plane.

export type AgentToolSource = "plugin" | "mcp";

/**
 * One entry in the compact merged tool index. `name` is the qualified name
 * used for schema fetch and execution:
 * - plugin tools keep their dispatcher name, e.g. `"acme.linear:search-issues"`
 * - MCP tools are `"mcp:{serverSlug}:{toolName}"`
 */
export interface MergedAgentToolIndexEntry {
  source: AgentToolSource;
  name: string;
  displayName: string | null;
  /** Trimmed for compactness; the schema endpoint returns the full text. */
  description: string | null;
  hasInputSchema: boolean;
  /** Plugin tools only. */
  pluginId?: string;
  /** MCP tools only. */
  serverId?: string;
  serverSlug?: string;
  serverName?: string;
  bindingMode?: McpServerBindingMode;
}

export interface MergedAgentToolCounts {
  plugin: number;
  mcp: number;
  total: number;
}

export interface MergedAgentToolIndexResponse {
  companyId: string;
  agentId: string;
  counts: MergedAgentToolCounts;
  tools: MergedAgentToolIndexEntry[];
  /** How to get a tool's full input schema: GET {schemaPath}?name={tool.name} */
  schemaPath: string;
  /** How to execute a tool: POST {executePath} with { name, arguments } */
  executePath: string;
}

export interface MergedAgentToolSchemaResponse {
  source: AgentToolSource;
  name: string;
  displayName: string | null;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  pluginId?: string;
  serverId?: string;
  serverSlug?: string;
  serverName?: string;
}

export interface ExecuteMergedAgentToolRequest {
  /** Qualified tool name from the merged index. */
  name: string;
  arguments?: Record<string, unknown>;
  /** Required for plugin tools (plugin tool runs are project-scoped). */
  projectId?: string | null;
}

export interface ExecuteMergedAgentToolResponse {
  ok: boolean;
  source: AgentToolSource;
  name: string;
  content: string | null;
  data: unknown;
  error: string | null;
}
