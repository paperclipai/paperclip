import { describe, expect, it } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { pluginTileState, type ConnectorRowModel, chatEndpointAttention } from "./Browse";

const gateway = { id: "gateway-1", status: "active", enabled: true, healthStatus: "ok", connectionPurpose: "tool", config: {} } as unknown as ToolConnection;
const gateways = new Map([[gateway.id, gateway]]);

function aggregatorRow(accountStatus: string, snapshot: Record<string, unknown> = {}): ConnectorRowModel {
  const app = { slug: "attio", name: "Attio", aliases: [], routes: [] };
  return {
    key: "aggregator:attio", slug: "attio", name: "Attio", description: "", brandKey: "attio", entry: null,
    applications: [], connections: [], chatEndpoints: [], aggregatorApp: app, upstreamCatalogApp: app,
    upstreamApps: [{ connectionId: gateway.id, toolkit: "attio", checkedAt: new Date().toISOString(), freshness: "fresh", accounts: [{ id: "a1", status: accountStatus }], ...snapshot }],
  } as unknown as ConnectorRowModel;
}

describe("pluginTileState", () => {
  it("is available until something is connected", () => {
    expect(pluginTileState({ ...aggregatorRow("ACTIVE"), upstreamApps: [] }, gateways)).toBe("available");
  });

  it("reads a healthy aggregator account as connected", () => {
    expect(pluginTileState(aggregatorRow("ACTIVE"), gateways)).toBe("connected");
  });

  it("flags an aggregator account that needs sign-in, is stale, or sits behind an unhealthy gateway", () => {
    expect(pluginTileState(aggregatorRow("EXPIRED"), gateways)).toBe("attention");
    expect(pluginTileState(aggregatorRow("INITIATED"), gateways)).toBe("attention");
    expect(pluginTileState(aggregatorRow("ACTIVE", { freshness: "stale" }), gateways)).toBe("attention");
    const paused = new Map([[gateway.id, { ...gateway, status: "draft" } as ToolConnection]]);
    expect(pluginTileState(aggregatorRow("ACTIVE"), paused)).toBe("attention");
  });
});

describe("chatEndpointAttention", () => {
  it("says why a chat connection needs the user, and nothing when it is fine", () => {
    expect(chatEndpointAttention({ status: "active", setup: null } as never)).toBeNull();
    expect(chatEndpointAttention({ status: "draft", setup: null } as never)).toBe("Setup not finished");
    expect(chatEndpointAttention({ status: "attention", setup: null } as never)).toBe("Needs attention");
    expect(chatEndpointAttention({ status: "revoked", setup: null } as never)).toBe("Access revoked");
  });
});
