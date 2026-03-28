import { describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents } from "@paperclipai/db";
import { authorizeUpgrade } from "../realtime/live-events-ws.js";

function createDbStub(options?: {
  keyRow?: Record<string, unknown> | null;
  agentRow?: Record<string, unknown> | null;
}) {
  let currentTable: unknown = null;
  return {
    select() {
      return {
        from(table: unknown) {
          currentTable = table;
          return {
            where() {
              if (currentTable === agentApiKeys) {
                return Promise.resolve(options?.keyRow ? [options.keyRow] : []);
              }
              if (currentTable === agents) {
                return Promise.resolve(options?.agentRow ? [options.agentRow] : []);
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

describe("authorizeUpgrade", () => {
  it("rejects local-trusted board websocket upgrades from untrusted origins", async () => {
    const req = {
      headers: {
        host: "127.0.0.1:3100",
        origin: "https://evil.example",
      },
    } as any;

    const result = await authorizeUpgrade(
      createDbStub() as never,
      req,
      "company-1",
      new URL("http://127.0.0.1:3100/api/companies/company-1/events/ws"),
      {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
      },
    );

    expect(result).toBeNull();
  });

  it("allows local-trusted board websocket upgrades from trusted origins", async () => {
    const req = {
      headers: {
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
      },
    } as any;

    const result = await authorizeUpgrade(
      createDbStub() as never,
      req,
      "company-1",
      new URL("http://127.0.0.1:3100/api/companies/company-1/events/ws"),
      {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
      },
    );

    expect(result).toEqual({
      actorId: "board",
      actorType: "board",
      companyId: "company-1",
    });
  });

  it("rejects agent websocket upgrades when the agent is terminated", async () => {
    const req = {
      headers: {
        host: "127.0.0.1:3100",
        authorization: "Bearer test-token",
      },
    } as any;

    const result = await authorizeUpgrade(
      createDbStub({
        keyRow: { id: "key-1", keyHash: "hash", companyId: "company-1", agentId: "agent-1" },
        agentRow: { id: "agent-1", companyId: "company-1", status: "terminated" },
      }) as never,
      req,
      "company-1",
      new URL("http://127.0.0.1:3100/api/companies/company-1/events/ws"),
      {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
      },
    );

    expect(result).toBeNull();
  });

  it("rejects websocket upgrades on private authenticated deployments when the host is not allowed", async () => {
    const req = {
      headers: {
        host: "evil.example:3100",
        authorization: "Bearer test-token",
      },
    } as any;

    const result = await authorizeUpgrade(
      createDbStub({
        keyRow: { id: "key-1", keyHash: "hash", companyId: "company-1", agentId: "agent-1" },
        agentRow: { id: "agent-1", companyId: "company-1", status: "active" },
      }) as never,
      req,
      "company-1",
      new URL("http://evil.example:3100/api/companies/company-1/events/ws"),
      {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
      },
    );

    expect(result).toBeNull();
  });
});
