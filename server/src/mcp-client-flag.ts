// Feature flag for the company-scoped MCP server registry ported from upstream PR #4259.
// Disabled by default: with PAPERCLIP_MCP_CLIENT_ENABLED unset or not "true", no MCP
// registry routes are mounted, no agent MCP tool routes are exposed, and heartbeat
// runs receive no MCP context — runtime behavior is identical to before the port.
//
// Naming is reconciled from the upstream CORTEX_MCP_CLIENT_ENABLED to the local
// PAPERCLIP_* convention (NEO-286 D2-5); the legacy name is honored as a fallback
// so upstream-authored env files keep working, with PAPERCLIP_* taking precedence.
//
// This process-wide flag only mounts the surface. Which tenants actually get MCP
// tools is gated per company by `companies.mcp_client_enabled` (off by default),
// enforced in agentMcpToolService — flag-GA is not on-for-everyone.
export function isMcpClientEnabled(): boolean {
  const value =
    process.env.PAPERCLIP_MCP_CLIENT_ENABLED ?? process.env.CORTEX_MCP_CLIENT_ENABLED;
  return value === "true";
}
