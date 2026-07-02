export type McpServerConfigInput = {
  name: string;
  transport?: "http" | "stdio" | "sse";
  url?: string;
  command?: string;
  args?: string[];
};

const MCP_REMOTE_RE = /\bmcp-remote\b/i;

export function isMcpRemoteCommand(command: string, args: string[] = []): boolean {
  return MCP_REMOTE_RE.test(command) || args.some((arg) => MCP_REMOTE_RE.test(arg));
}

export function assertAllowedMcpTransport(server: McpServerConfigInput): void {
  const transport = server.transport ?? (server.command ? "stdio" : "http");
  if (transport === "sse") {
    throw new Error(
      `MCP server "${server.name}": transport "sse" is not supported in cursor_cloud (use "http")`,
    );
  }
  if (transport === "stdio" && isMcpRemoteCommand(server.command ?? "", server.args ?? [])) {
    throw new Error(`MCP server "${server.name}": mcp-remote stdio bridge is not supported in cloud agents`);
  }
  if (transport === "http" && server.url && /\/sse(?:\?|$)/i.test(server.url)) {
    throw new Error(
      `MCP server "${server.name}": SSE URLs are not supported; use Streamable HTTP endpoint`,
    );
  }
}
