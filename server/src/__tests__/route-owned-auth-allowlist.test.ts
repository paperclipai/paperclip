import { describe, expect, it } from "vitest";
import { isRouteOwnedAuthPath } from "../middleware/route-owned-auth.js";

describe("route-owned authentication allowlist", () => {
  it("covers the gateway protocol and session data-plane surfaces", () => {
    expect(isRouteOwnedAuthPath("/mcp/gateways/gw_0ec8c0a937dd4b989d2e4f951d7ba94c")).toBe(true);
    expect(isRouteOwnedAuthPath("/api/tool-gateway/gateways/6740305d-0000-4000-8000-000000000000/mcp")).toBe(true);
    expect(isRouteOwnedAuthPath("/api/tool-gateway/tools")).toBe(true);
    expect(isRouteOwnedAuthPath("/api/tool-gateway/tools/call")).toBe(true);
  });

  it("matches the router's default trailing-slash and case handling", () => {
    expect(isRouteOwnedAuthPath("/api/tool-gateway/tools/")).toBe(true);
    expect(isRouteOwnedAuthPath("/API/Tool-Gateway/Tools/Call")).toBe(true);
    expect(isRouteOwnedAuthPath("/MCP/Gateways/gw_abc")).toBe(true);
  });

  it("never exempts management endpoints", () => {
    for (const path of [
      "/api/tool-gateway/sessions",
      "/api/tool-gateway/sessions/6740305d-0000-4000-8000-000000000000/revoke",
      "/api/tool-gateway/gateways/6740305d-0000-4000-8000-000000000000",
      "/api/tool-gateway/gateways/6740305d-0000-4000-8000-000000000000/tokens",
      "/api/tool-gateway/gateway-tokens/6740305d-0000-4000-8000-000000000000/revoke",
      "/api/tool-gateway/action-requests/6740305d-0000-4000-8000-000000000000/approve",
      "/api/tool-gateway/action-requests/6740305d-0000-4000-8000-000000000000/decline",
      "/api/tool-gateway/runtime-slots",
      "/api/tool-gateway/runtime-slots/6740305d-0000-4000-8000-000000000000/stop",
      "/api/tool-gateway/audit",
      "/api/companies/6740305d-0000-4000-8000-000000000000/tools/gateways",
    ]) {
      expect(isRouteOwnedAuthPath(path), path).toBe(false);
    }
  });

  it("does not exempt unrelated API routes or deeper paths under the allowlisted ones", () => {
    expect(isRouteOwnedAuthPath("/api/companies")).toBe(false);
    expect(isRouteOwnedAuthPath("/api/agents/me")).toBe(false);
    expect(isRouteOwnedAuthPath("/mcp/gateways")).toBe(false);
    expect(isRouteOwnedAuthPath("/mcp/gateways/gw_abc/tokens")).toBe(false);
    expect(isRouteOwnedAuthPath("/api/tool-gateway/tools/call/extra")).toBe(false);
    // `req.path` is never percent-decoded, so an encoded separator must not
    // smuggle a management path past the allowlist.
    expect(isRouteOwnedAuthPath("/api/tool-gateway/tools%2Fcall")).toBe(false);
  });
});
