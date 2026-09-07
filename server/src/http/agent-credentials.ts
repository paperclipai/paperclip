export type AgentCredentialClassification =
  | { kind: "none" }
  | { kind: "invalid"; reason: "empty_bearer" }
  | { kind: "gateway"; token: string }
  | { kind: "agent"; token: string };

const PUBLIC_MCP_GATEWAY_PATH = /^\/mcp\/gateways\/gw_[a-f0-9]{32}\/?$/i;

/**
 * Classify bearer input before credential verification. The MCP gateway owns
 * its own `pcgw_` credential; only its exact public gateway path receives that
 * exception. All other bearer values remain agent/board credential candidates.
 */
export function classifyAgentCredentials(
  pathname: string,
  authorization: string | undefined,
): AgentCredentialClassification {
  if (!authorization || !/^bearer(?:\s|$)/i.test(authorization)) {
    return { kind: "none" };
  }

  const token = authorization.slice("bearer".length).trim();
  if (!token) return { kind: "invalid", reason: "empty_bearer" };
  if (PUBLIC_MCP_GATEWAY_PATH.test(pathname)) {
    return { kind: "gateway", token };
  }
  return { kind: "agent", token };
}
