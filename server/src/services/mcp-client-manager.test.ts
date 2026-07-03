import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createTransportForTarget,
  McpClientManagerError,
  mcpClientManager,
  type McpClientTarget,
} from "./mcp-client-manager.js";

function httpTarget(overrides: Partial<McpClientTarget> = {}): McpClientTarget {
  return {
    companyId: "company-a",
    mcpServerId: "server-1",
    transport: "http",
    endpoint: "https://mcp.example.com/mcp",
    ...overrides,
  };
}

describe("mcp-client-manager (D2-1 skeleton)", () => {
  it("resolves the official SDK client import surface", () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    expect(client).toBeInstanceOf(Client);
  });

  it("constructs SDK transports for http and sse targets", () => {
    expect(createTransportForTarget(httpTarget())).toBeDefined();
    expect(createTransportForTarget(httpTarget({ transport: "sse" }))).toBeDefined();
  });

  it("rejects http/sse targets without an endpoint", () => {
    expect(() => createTransportForTarget(httpTarget({ endpoint: undefined }))).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );
  });

  it("refuses stdio targets at the pool boundary while stdio is gated", async () => {
    const manager = mcpClientManager();
    const target = httpTarget({ transport: "stdio", endpoint: undefined, command: "evil" });
    await expect(manager.acquire(target)).rejects.toThrowError(
      expect.objectContaining({ name: "McpClientManagerError", code: "stdio_gated" }),
    );
  });

  it("rejects http acquire as not implemented until D2-3 lands connection", async () => {
    const manager = mcpClientManager();
    await expect(manager.acquire(httpTarget())).rejects.toBeInstanceOf(McpClientManagerError);
    await expect(manager.acquire(httpTarget())).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("starts with an empty pool and survives invalidation/shutdown no-ops", async () => {
    const manager = mcpClientManager();
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });
    await manager.invalidateCompany("company-a");
    await manager.invalidateServer("company-a", "server-1");
    await manager.shutdown();
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });
  });
});
