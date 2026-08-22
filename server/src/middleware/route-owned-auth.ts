/**
 * Route-owned authentication surfaces.
 *
 * `actorMiddleware` is mounted globally and knows exactly three credential
 * families: board API keys, agent API keys, and local agent JWTs. A bearer
 * credential outside that set is rejected there with a generic actor-token 401.
 *
 * Two product-issued credential families are deliberately validated by their
 * own routes instead: the named MCP gateway client token
 * (`pcgw_<tokenId>.<secret>`, handed to the operator to paste into Cursor /
 * Claude Desktop) and the tool-gateway session token
 * (`pcgt_<sessionId>.<secret>`). Before this allowlist existed the global
 * middleware consumed those bearers first, so the MCP protocol endpoints
 * answered `401 {"error":"Agent token did not verify; …"}` for the very tokens
 * the product minted for them.
 *
 * The allowlist is intentionally an exact-shape path match rather than
 * token-prefix sniffing, and it covers only the protocol/data-plane endpoints
 * whose handlers perform their own credential validation. Every management
 * endpoint — gateway CRUD, token mint/revoke, session create/revoke, approvals,
 * runtime slots, audit — is absent here and keeps global actor authentication.
 */
const ROUTE_OWNED_AUTH_PATTERNS: readonly RegExp[] = [
  // Named gateway MCP protocol, public-id endpoint (the pasteable one).
  /^\/mcp\/gateways\/[^/]+$/,
  // Named gateway MCP protocol, internal id endpoint (same auth path).
  /^\/api\/tool-gateway\/gateways\/[^/]+\/mcp$/,
  // Tool-gateway session data plane.
  /^\/api\/tool-gateway\/tools$/,
  /^\/api\/tool-gateway\/tools\/call$/,
];

/**
 * Normalizes a request path the same way Express routing does by default:
 * matching is case-insensitive (`caseSensitive: false`) and a trailing slash is
 * not significant (`strict: false`). Normalizing here keeps the allowlist and
 * the router in agreement — otherwise `/api/tool-gateway/tools/` would route to
 * the tools handler while still being rejected by the global bearer branch.
 *
 * Percent-encoded separators are left untouched on purpose: `req.path` is not
 * decoded, and neither is Express's own path match, so an encoded segment fails
 * both this allowlist and the route — the safe direction.
 */
function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
}

/** Whether the route serving `path` validates its own bearer credential. */
export function isRouteOwnedAuthPath(path: string): boolean {
  const normalized = normalizePath(path);
  return ROUTE_OWNED_AUTH_PATTERNS.some((pattern) => pattern.test(normalized));
}
