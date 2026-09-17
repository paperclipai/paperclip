import { toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
let telemetryClient: { track: typeof track } | null = { track };

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => telemetryClient,
}));

const {
  connectorKeyForConnection,
  emitConnectorConnectionCreated,
  emitConnectorConnectionUpdated,
  emitConnectorInvocationCompleted,
  invocationOrigin,
} = await import("./connector-telemetry.js");

type ToolConnectionRow = typeof toolConnections.$inferSelect;
type ToolInvocationRow = typeof toolInvocations.$inferSelect;

function connectionRow(overrides: Record<string, unknown> = {}): ToolConnectionRow {
  return {
    id: "conn-1",
    connectionPurpose: "tool",
    transport: "mcp_remote",
    authKind: "oauth",
    status: "active",
    enabled: true,
    config: { sourceTemplateKey: "github" },
    ...overrides,
  } as unknown as ToolConnectionRow;
}

function invocationRow(overrides: Record<string, unknown> = {}): ToolInvocationRow {
  return {
    id: "inv-1",
    connectionId: "conn-1",
    status: "succeeded",
    actorType: "agent",
    runId: "run-1",
    issueId: "issue-1",
    gatewayId: "gw-1",
    startedAt: new Date("2026-09-17T00:00:00.000Z"),
    completedAt: new Date("2026-09-17T00:00:07.400Z"),
    ...overrides,
  } as unknown as ToolInvocationRow;
}

function fakeDb(
  invocation: ToolInvocationRow | null,
  connection: ToolConnectionRow | null,
): Db {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(
            table === toolInvocations
              ? invocation
                ? [invocation]
                : []
              : connection
                ? [connection]
                : [],
          ),
      }),
    }),
  } as unknown as Db;
}

beforeEach(() => {
  track.mockReset();
  telemetryClient = { track };
});

describe("connectorKeyForConnection", () => {
  it("keeps a sourceTemplateKey that resolves in the shared catalog", () => {
    expect(connectorKeyForConnection(connectionRow())).toBe("github");
  });

  it("reports custom for keys outside the catalog", () => {
    expect(
      connectorKeyForConnection(connectionRow({ config: { sourceTemplateKey: "my-internal-server" } })),
    ).toBe("custom");
  });

  it("reports custom when the key is missing or not a string", () => {
    expect(connectorKeyForConnection(connectionRow({ config: {} }))).toBe("custom");
    expect(
      connectorKeyForConnection(connectionRow({ config: { sourceTemplateKey: 42 } })),
    ).toBe("custom");
  });
});

describe("invocationOrigin", () => {
  it("labels user-driven connection tests without run context as setup_test", () => {
    expect(
      invocationOrigin(
        invocationRow({ actorType: "user", runId: null, issueId: null, gatewayId: null }),
      ),
    ).toBe("setup_test");
  });

  it("keeps the actor type for run-attached invocations", () => {
    expect(invocationOrigin(invocationRow())).toBe("agent");
    expect(invocationOrigin(invocationRow({ actorType: "user" }))).toBe("user");
  });
});

describe("emitConnectorConnectionCreated", () => {
  it("emits catalog identity and lifecycle state for tool connections", () => {
    emitConnectorConnectionCreated(connectionRow(), "gallery");
    expect(track).toHaveBeenCalledWith("connector.connection_created", {
      connector_key: "github",
      transport: "mcp_remote",
      auth_kind: "oauth",
      setup_flow: "gallery",
      status: "active",
      enabled: true,
    });
  });

  it("never emits for channel or AI connections", () => {
    emitConnectorConnectionCreated(connectionRow({ connectionPurpose: "channel" }), "api");
    expect(track).not.toHaveBeenCalled();
  });

  it("is a no-op without an initialized telemetry client", () => {
    telemetryClient = null;
    expect(() => emitConnectorConnectionCreated(connectionRow(), "gallery")).not.toThrow();
  });

  it("swallows client failures instead of failing the setup path", () => {
    track.mockImplementation(() => {
      throw new Error("sink offline");
    });
    expect(() => emitConnectorConnectionCreated(connectionRow(), "gallery")).not.toThrow();
  });
});

describe("emitConnectorConnectionUpdated", () => {
  it("stays silent when the committed write left status and enabled unchanged", () => {
    emitConnectorConnectionUpdated(
      connectionRow(),
      { status: "active", enabled: true },
      "update_api",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("emits the transition when lifecycle status changes", () => {
    emitConnectorConnectionUpdated(
      connectionRow(),
      { status: "draft", enabled: true },
      "oauth_callback",
    );
    expect(track).toHaveBeenCalledWith("connector.connection_updated", {
      connector_key: "github",
      transport: "mcp_remote",
      auth_kind: "oauth",
      change_source: "oauth_callback",
      previous_status: "draft",
      status: "active",
      previous_enabled: true,
      enabled: true,
    });
  });

  it("emits when only the enabled flag flips", () => {
    emitConnectorConnectionUpdated(
      connectionRow({ enabled: false }),
      { status: "active", enabled: true },
      "update_api",
    );
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      previous_enabled: true,
      enabled: false,
    });
  });

  it("never emits for non-tool connections even on lifecycle changes", () => {
    emitConnectorConnectionUpdated(
      connectionRow({ connectionPurpose: "channel" }),
      { status: "draft", enabled: true },
      "update_api",
    );
    expect(track).not.toHaveBeenCalled();
  });
});

describe("emitConnectorInvocationCompleted", () => {
  it("emits terminal outcome, origin, and duration from the committed row", async () => {
    await emitConnectorInvocationCompleted(fakeDb(invocationRow(), connectionRow()), "inv-1");
    expect(track).toHaveBeenCalledWith("connector.invocation_completed", {
      connector_key: "github",
      transport: "mcp_remote",
      status: "succeeded",
      origin: "agent",
      duration_seconds: 7,
    });
  });

  it("omits duration when the invocation never recorded a start time", async () => {
    await emitConnectorInvocationCompleted(
      fakeDb(invocationRow({ startedAt: null, status: "denied" }), connectionRow()),
      "inv-1",
    );
    expect(track.mock.calls[0]?.[1]).not.toHaveProperty("duration_seconds");
    expect(track.mock.calls[0]?.[1]).toMatchObject({ status: "denied" });
  });

  it("ignores in-flight statuses so approval waits never count as failures", async () => {
    await emitConnectorInvocationCompleted(
      fakeDb(invocationRow({ status: "awaiting_approval" }), connectionRow()),
      "inv-1",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores invocations without a connection or with a non-tool connection", async () => {
    await emitConnectorInvocationCompleted(
      fakeDb(invocationRow({ connectionId: null }), connectionRow()),
      "inv-1",
    );
    await emitConnectorInvocationCompleted(
      fakeDb(invocationRow(), connectionRow({ connectionPurpose: "channel" })),
      "inv-1",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("resolves without emitting when the invocation row is missing", async () => {
    await expect(
      emitConnectorInvocationCompleted(fakeDb(null, null), "inv-missing"),
    ).resolves.toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });
});
