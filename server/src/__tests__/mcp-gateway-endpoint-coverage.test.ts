import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isMcpGatewayProtocolPath,
  mcpGatewayApiEndpointPath,
  mcpGatewayPublicEndpointPath,
} from "../services/mcp-gateway-endpoints.js";

const GATEWAY_ID = "819f6caa-92bb-41ee-a33c-3e35bd577a8f";
const GATEWAY_PUBLIC_ID = "gw_61df2b661160478d9091986dbe51b2d8";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Category safeguard for BRO-2546.
 *
 * The failure class: Paperclip mints a credential for one of its own endpoints,
 * and something upstream of the route rejects it. That failure is silent — an
 * MCP client that cannot `initialize` just registers zero tools — so it has to
 * be caught structurally rather than observed.
 */
describe("MCP gateway endpoint coverage", () => {
  it("admits every endpoint path Paperclip builds for a gateway", () => {
    expect(isMcpGatewayProtocolPath(mcpGatewayApiEndpointPath(GATEWAY_ID))).toBe(true);
    expect(isMcpGatewayProtocolPath(mcpGatewayPublicEndpointPath(GATEWAY_PUBLIC_ID))).toBe(true);
  });

  it("does not admit neighbouring tool-gateway routes", () => {
    // These are ordinary board/agent-authenticated routes. Widening the matcher
    // to cover them would hand a gateway token API surface it must not reach.
    expect(isMcpGatewayProtocolPath(`/api/tool-gateway/gateways/${GATEWAY_ID}`)).toBe(false);
    expect(isMcpGatewayProtocolPath(`/api/tool-gateway/gateways/${GATEWAY_ID}/tokens`)).toBe(false);
    expect(isMcpGatewayProtocolPath("/api/tool-gateway/tools/call")).toBe(false);
    expect(isMcpGatewayProtocolPath("/api/tool-gateway/audit")).toBe(false);
    expect(isMcpGatewayProtocolPath("/api/agents/me")).toBe(false);
  });

  it("keeps the runtime MCP server URL on a path the actor middleware admits", () => {
    // `buildPaperclipRuntimeMcpServers` hands this URL to every adapter. If it
    // is ever rebuilt inline again, this assertion is the thing that notices.
    const heartbeat = readSource("../services/heartbeat.ts");
    expect(heartbeat).toContain("mcpGatewayApiEndpointPath(gateway.id)");
    expect(heartbeat).not.toMatch(/`\/api\/tool-gateway\/gateways\/\$\{[^}]+\}\/mcp`/);
  });

  it("keeps the gateway protocol routes mounted on the advertised paths", () => {
    // The route file declares its own mount paths and echoes them back to
    // clients in the discovery response. Both must stay in the admitted set.
    const routes = readSource("../routes/tool-gateway.ts");
    expect(routes).toContain('router.post("/mcp/gateways/:gatewayPublicId"');
    expect(routes).toContain('router.post("/tool-gateway/gateways/:gatewayId/mcp"');
  });
});
