// Feature flag for the company-scoped MCP server registry ported from upstream PR #4259.
// Disabled by default: with PAPERCLIP_MCP_CLIENT_ENABLED unset or not "true", no MCP
// registry routes are mounted, no agent MCP tool routes are exposed, and heartbeat
// runs receive no MCP context — runtime behavior is identical to before the port.
export function isMcpClientEnabled(): boolean {
  return process.env.PAPERCLIP_MCP_CLIENT_ENABLED === "true";
}
