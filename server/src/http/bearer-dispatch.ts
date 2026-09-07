export type BearerRequestKind =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "credential"; token: string }
  | { kind: "gateway"; token: string };

const PUBLIC_MCP_GATEWAY_PATH = /^\/mcp\/gateways\/gw_[a-f0-9]{32}\/?$/i;

/**
 * Classify bearer traffic before credential verification. The public MCP
 * gateway credential is owned by the gateway protocol and must not be sent to
 * board-key or agent-JWT verification. The exception is restricted to the
 * unguessable gateway path; lookalikes remain normal credentials.
 */
export function classifyBearerRequest(
  pathname: string,
  authorization: string | undefined,
): BearerRequestKind {
  if (!authorization || !/^bearer(?:\s|$)/i.test(authorization)) {
    return { kind: "none" };
  }

  const token = authorization.slice("bearer".length).trim();
  if (!token) return { kind: "empty" };
  if (PUBLIC_MCP_GATEWAY_PATH.test(pathname)) {
    return { kind: "gateway", token };
  }
  return { kind: "credential", token };
}
