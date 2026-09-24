/** Providers whose own MCP endpoint defines the catalog and authentication. */
export const REMOTE_MCP_CONNECTOR_METHODS = {
  zapier: "generated-url",
  arcade: "mcp",
  composio: "mcp",
  executor: "mcp",
} as const;

export type RemoteMcpConnectorId = keyof typeof REMOTE_MCP_CONNECTOR_METHODS;
export function isRemoteMcpConnectorId(value: unknown): value is RemoteMcpConnectorId {
  return typeof value === "string" && Object.hasOwn(REMOTE_MCP_CONNECTOR_METHODS, value);
}
export function isRemoteMcpConnectorMethod(provider: unknown, method: unknown): boolean {
  return isRemoteMcpConnectorId(provider) && method === REMOTE_MCP_CONNECTOR_METHODS[provider];
}
