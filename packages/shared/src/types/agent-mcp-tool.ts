export interface AgentMcpToolDescriptor {
  serverId: string;
  serverName: string;
  serverSlug: string;
  bindingMode: "allowed" | "preferred" | "required";
  toolName: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

export interface AgentMcpServerToolCatalog {
  serverId: string;
  serverName: string;
  serverSlug: string;
  bindingMode: "allowed" | "preferred" | "required";
  enabled: boolean;
  toolCount: number;
  tools: AgentMcpToolDescriptor[];
}

export interface AgentMcpToolListResponse {
  servers: AgentMcpServerToolCatalog[];
  tools: AgentMcpToolDescriptor[];
}

export interface ExecuteAgentMcpToolRequest {
  serverId?: string | null;
  serverName?: string | null;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface ExecuteAgentMcpToolResponse {
  ok: boolean;
  serverId: string;
  serverName: string;
  serverSlug: string;
  toolName: string;
  content: string | null;
  data: unknown;
  error: string | null;
  /**
   * NEO-448 Phase 3: taint label — the clearance class of the tool that
   * produced this result. Any surface that re-shows the result (session
   * replay, memory retrieval, comment/room rendering) must re-check the
   * reader's clearance against this ceiling.
   */
  clearanceCeiling?: "guest" | "member" | "board";
}
