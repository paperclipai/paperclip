/**
 * One source of truth for the MCP gateway protocol endpoints.
 *
 * These endpoints are unusual: they authenticate their own bearer credential (a
 * `pcgw_` gateway token) inside the route handler and never read `req.actor`.
 * The global actor middleware therefore has to let that credential through
 * untouched, and the heartbeat has to hand adapters a URL that matches one of
 * these shapes.
 *
 * Keeping the builder and the matcher in the same module means a change to the
 * URL shape can't silently desynchronize the two — see the guard in
 * `mcp-gateway-endpoint-coverage.test.ts`. When those drifted apart the failure
 * was invisible: every managed MCP server 401'd during `initialize`, MCP
 * clients registered zero tools, and agents simply saw no `mcp__*` tools at all
 * (BRO-2546).
 */

/** Per-gateway mount under `/api`, keyed by gateway id. */
export function mcpGatewayApiEndpointPath(gatewayId: string): string {
  return `/api/tool-gateway/gateways/${gatewayId}/mcp`;
}

/** Public streamable-HTTP mount, keyed by `gateway_public_id`. */
export function mcpGatewayPublicEndpointPath(gatewayPublicId: string): string {
  return `/mcp/gateways/${gatewayPublicId}`;
}

const MCP_GATEWAY_PROTOCOL_PATH_PATTERNS = [
  /^\/mcp\/gateways\/[^/]+\/?$/,
  /^\/api\/tool-gateway\/gateways\/[^/]+\/mcp\/?$/,
];

export function isMcpGatewayProtocolPath(path: string): boolean {
  return MCP_GATEWAY_PROTOCOL_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
