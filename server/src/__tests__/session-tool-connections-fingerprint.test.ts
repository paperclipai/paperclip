import { describe, expect, it } from "vitest";
import { buildEffectiveRunToolConnectionsConfigValue } from "../services/heartbeat/workspaces.js";

type Connection = Parameters<
  typeof buildEffectiveRunToolConnectionsConfigValue
>[0]["installedConnections"][number];

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Example Tools",
  status: "active",
  enabled: true,
  transport: "mcp_remote",
  credentialPolicy: "shared",
  healthStatus: "ok",
  installs: [{ targetType: "company" }],
  ...overrides,
});

const value = (
  connections: Connection[],
  permittedConnectionIds: string[] = connections.map((item) => item.id),
) =>
  buildEffectiveRunToolConnectionsConfigValue({
    installedConnections: connections,
    permittedConnectionIds,
  });

describe("tool-connection session fingerprint value", () => {
  it("does not change when a health poll rewrites volatile columns", () => {
    // updateConnectionHealth rewrites these on every poll. If they reached the
    // fingerprint, each poll would rotate every task session.
    const before = value([connection()]);
    const polled = {
      ...connection(),
      updatedAt: new Date("2031-01-01T00:00:00.000Z"),
      healthCheckedAt: new Date("2031-01-01T00:00:00.000Z"),
      lastHealthAt: new Date("2031-01-01T00:00:00.000Z"),
      healthMessage: "checked",
      lastError: null,
    } as Connection;
    expect(value([polled])).toEqual(before);
  });

  it("changes when a connection is disabled or archived", () => {
    const active = value([connection()]);
    expect(value([connection({ enabled: false })])).not.toEqual(active);
    expect(value([connection({ status: "archived" })])).not.toEqual(active);
  });

  it("keeps an absent status distinct from active, because it does not attach", () => {
    // ToolConnection.status is optional. Widening undefined to "active" would
    // hide a connection that cannot attach.
    expect(value([connection({ status: undefined })])).not.toEqual(
      value([connection({ status: "active" })]),
    );
    expect(value([connection({ status: undefined })])).toEqual(
      value([connection({ status: null })]),
    );
  });

  it("changes when a connection stops being permitted", () => {
    expect(value([connection()], [])).not.toEqual(value([connection()]));
  });

  it("changes when a connection needs attention, because it stops attaching", () => {
    expect(value([connection({ healthStatus: "error" })])).not.toEqual(
      value([connection()]),
    );
  });

  it("changes when a connection is installed or uninstalled", () => {
    const second = connection({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Second Tools",
    });
    expect(value([connection(), second])).not.toEqual(value([connection()]));
  });

  it("changes when a connection is renamed, because tool names embed the name", () => {
    expect(value([connection({ name: "Renamed Tools" })])).not.toEqual(
      value([connection()]),
    );
  });

  it("is stable when the resolver returns the same connections in a different order", () => {
    const second = connection({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Second Tools",
    });
    expect(value([second, connection()])).toEqual(
      value([connection(), second]),
    );
    expect(value([connection()], ["b", "a"])).toEqual(
      value([connection()], ["a", "b"]),
    );
  });
});
