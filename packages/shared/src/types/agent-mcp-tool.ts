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
}
