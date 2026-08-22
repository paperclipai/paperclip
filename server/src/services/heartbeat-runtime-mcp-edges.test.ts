import { describe, expect, it, vi } from "vitest";

const getEffectiveProfilesForAgent = vi.fn();
const recordRuntimeMcpDeliveryDiagnostic = vi.fn();
const createNamedGateway = vi.fn();
const createNamedGatewayToken = vi.fn();

vi.mock("./tool-access.js", () => ({
  toolAccessService: () => ({ getEffectiveProfilesForAgent }),
}));

vi.mock("./tool-gateway.js", () => ({
  createToolGatewayService: () => ({
    recordRuntimeMcpDeliveryDiagnostic,
    createNamedGateway,
    createNamedGatewayToken,
  }),
}));

import { buildPaperclipRuntimeMcpServers } from "./heartbeat.js";

describe("heartbeat runtime MCP edge coverage", () => {
  function queuedDb(...results: unknown[][]) {
    const queue = [...results];
    return {
      select: vi.fn(() => {
        const result = queue.shift() ?? [];
        const query: Record<string, unknown> = {};
        for (const method of ["from", "where", "limit"]) query[method] = vi.fn(() => query);
        query.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
        return query;
      }),
    };
  }

  it("derives and sorts permitted-but-uninstalled connections from effective entries", async () => {
    getEffectiveProfilesForAgent.mockResolvedValue({
      entries: [
        { effect: "exclude", connectionId: "ignored" },
        { effect: "include", connectionId: null },
        { effect: "include", connectionId: "connection-b" },
        { effect: "include", connectionId: "connection-a" },
      ],
      allowedTools: [{ connectionId: "connection-a" }],
      installedConnections: [],
    });
    const rows = [
      { id: "connection-b", name: "Zulu", transport: "mcp_remote" },
      { id: "connection-a", name: "Alpha", transport: "mcp_remote" },
    ];
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where"]) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);

    await expect(buildPaperclipRuntimeMcpServers({
      db: { select: vi.fn(() => query) } as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
    })).resolves.toEqual([]);
    expect(recordRuntimeMcpDeliveryDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      permittedNotInstalledConnections: [
        { id: "connection-a", name: "Alpha" },
        { id: "connection-b", name: "Zulu" },
      ],
    }));
  });

  it("skips an installed connection whose runtime profile disappeared", async () => {
    getEffectiveProfilesForAgent.mockResolvedValue({
      entries: [{ effect: "include", connectionId: "connection-a" }],
      allowedTools: [],
      installedConnections: [{
        id: "connection-a", companyId: "company-1", name: "Alpha", status: "active",
        enabled: true, transport: "mcp_remote",
      }],
    });
    const db = queuedDb(
      [{ id: "connection-a", name: "Alpha", transport: "mcp_remote" }],
      [],
    );
    await expect(buildPaperclipRuntimeMcpServers({
      db: db as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
    })).resolves.toEqual([]);
    expect(recordRuntimeMcpDeliveryDiagnostic).toHaveBeenCalled();
  });

  it("requires the API URL only when a managed server is delivered", async () => {
    const previous = process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    getEffectiveProfilesForAgent.mockResolvedValue({
      entries: [{ effect: "include", connectionId: "connection-a" }],
      allowedTools: [],
      installedConnections: [{
        id: "connection-a", companyId: "company-1", name: "Alpha", status: "active",
        enabled: true, transport: "mcp_remote",
      }],
    });
    createNamedGatewayToken.mockResolvedValue({ token: "secret" });
    const gateway = { id: "gateway-1", metadata: { managedRuntimeConnectionId: "connection-a" } };
    const db = queuedDb(
      [{ id: "connection-a", name: "Alpha", transport: "mcp_remote" }],
      [{ id: "profile-1" }],
      [gateway],
    );
    await expect(buildPaperclipRuntimeMcpServers({
      db: db as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
    })).rejects.toThrow(/PAPERCLIP_API_URL/);
    if (previous === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = previous;
  });

  it("recovers a concurrent managed-gateway creation race", async () => {
    const previous = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "https://paperclip.test/api/";
    getEffectiveProfilesForAgent.mockResolvedValue({
      entries: [{ effect: "include", connectionId: "connection-a" }],
      allowedTools: [],
      installedConnections: [{
        id: "connection-a", companyId: "company-1", name: "Alpha", status: "active",
        enabled: true, transport: "mcp_remote",
      }],
    });
    createNamedGateway.mockRejectedValueOnce(new Error("duplicate"));
    createNamedGatewayToken.mockResolvedValue({ token: "secret-token" });
    const gateway = { id: "gateway-1", metadata: { managedRuntimeConnectionId: "connection-a" } };
    const db = queuedDb(
      [{ id: "connection-a", name: "Alpha", transport: "mcp_remote" }],
      [{ id: "profile-1" }],
      [],
      [gateway],
    );
    await expect(buildPaperclipRuntimeMcpServers({
      db: db as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
    })).resolves.toEqual([expect.objectContaining({
      name: "Alpha",
      url: "https://paperclip.test/api/tool-gateway/gateways/gateway-1/mcp",
      token: "secret-token",
    })]);
    if (previous === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = previous;
  });

  it("handles missing gateway rows after managed creation attempts", async () => {
    getEffectiveProfilesForAgent.mockResolvedValue({
      entries: [{ effect: "include", connectionId: "connection-a" }],
      allowedTools: [],
      installedConnections: [{
        id: "connection-a", companyId: "company-1", name: "Alpha", status: "active",
        enabled: true, transport: "mcp_remote",
      }],
    });
    createNamedGateway.mockResolvedValueOnce({ id: "missing-gateway" });
    const absentAfterCreate = queuedDb(
      [{ id: "connection-a", name: "Alpha", transport: "mcp_remote" }], [{ id: "profile-1" }], [], [],
    );
    await expect(buildPaperclipRuntimeMcpServers({
      db: absentAfterCreate as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" }, runId: "run-1",
    })).resolves.toEqual([]);

    createNamedGateway.mockRejectedValueOnce(new Error("create failed"));
    const absentAfterRace = queuedDb(
      [{ id: "connection-a", name: "Alpha", transport: "mcp_remote" }], [{ id: "profile-1" }], [], [],
    );
    await expect(buildPaperclipRuntimeMcpServers({
      db: absentAfterRace as never,
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" }, runId: "run-2",
    })).rejects.toThrow("create failed");
  });
});
