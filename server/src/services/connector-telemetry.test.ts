import { toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
const isRegisteredEventName = vi.fn(() => true);
let telemetryClient: {
  track: typeof track;
  isRegisteredEventName: typeof isRegisteredEventName;
} | null = { track, isRegisteredEventName };

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => telemetryClient,
}));

const {
  aggregatorAppTelemetrySlug,
  connectorKeyForConnection,
  emitAggregatorAppRequestsFromToolCall,
  emitAggregatorAppsLinked,
  emitAggregatorAppsRequested,
  emitConnectionCreated,
  emitConnectionUpdated,
  emitConnectionInvoked,
  invocationOrigin,
  newlyLinkedToolkits,
  serverDomainForConnection,
  serverDomainForUrl,
} = await import("./connector-telemetry.js");
const { AGGREGATOR_APP_CATALOG } = await import("@paperclipai/shared/aggregator-app-catalog");

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
): Db & { selectCalls: () => number } {
  let selectCalls = 0;
  return {
    selectCalls: () => selectCalls,
    select: () => {
      selectCalls += 1;
      return {
        from: () => ({
          innerJoin: () => ({
            where: () =>
              Promise.resolve(
                // Mirror the emitter's single joined read: an invocation with
                // no (or a deleted) connection joins to zero rows.
                invocation && connection && invocation.connectionId
                  ? [{ invocation, connection }]
                  : [],
              ),
          }),
        }),
      };
    },
  } as unknown as Db & { selectCalls: () => number };
}

beforeEach(() => {
  track.mockReset();
  isRegisteredEventName.mockReset();
  isRegisteredEventName.mockReturnValue(true);
  telemetryClient = { track, isRegisteredEventName };
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

describe("emitConnectionCreated", () => {
  it("emits catalog identity and lifecycle state for tool connections", () => {
    emitConnectionCreated(connectionRow(), "gallery");
    expect(track).toHaveBeenCalledWith("connection.created", {
      connector_key: "github",
      transport: "mcp_remote",
      auth_kind: "oauth",
      setup_flow: "gallery",
      status: "active",
      enabled: true,
    });
  });

  it("never emits for channel or AI connections", () => {
    emitConnectionCreated(connectionRow({ connectionPurpose: "channel" }), "api");
    expect(track).not.toHaveBeenCalled();
  });

  it("is a no-op without an initialized telemetry client", () => {
    telemetryClient = null;
    expect(() => emitConnectionCreated(connectionRow(), "gallery")).not.toThrow();
  });

  it("swallows client failures instead of failing the setup path", () => {
    track.mockImplementation(() => {
      throw new Error("sink offline");
    });
    expect(() => emitConnectionCreated(connectionRow(), "gallery")).not.toThrow();
  });
});

describe("emitConnectionUpdated", () => {
  it("stays silent when the committed write left status and enabled unchanged", () => {
    emitConnectionUpdated(
      connectionRow(),
      { status: "active", enabled: true },
      "api",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("emits the transition when lifecycle status changes", () => {
    emitConnectionUpdated(
      connectionRow(),
      { status: "draft", enabled: true },
      "oauth_callback",
    );
    expect(track).toHaveBeenCalledWith("connection.updated", {
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
    emitConnectionUpdated(
      connectionRow({ enabled: false }),
      { status: "active", enabled: true },
      "api",
    );
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      previous_enabled: true,
      enabled: false,
    });
  });

  it("never emits for non-tool connections even on lifecycle changes", () => {
    emitConnectionUpdated(
      connectionRow({ connectionPurpose: "channel" }),
      { status: "draft", enabled: true },
      "api",
    );
    expect(track).not.toHaveBeenCalled();
  });
});

describe("emitConnectionInvoked", () => {
  it("emits terminal outcome, origin, and duration from the committed row", async () => {
    await emitConnectionInvoked(fakeDb(invocationRow(), connectionRow()), "inv-1");
    expect(track).toHaveBeenCalledWith("connection.invoked", {
      connector_key: "github",
      transport: "mcp_remote",
      status: "succeeded",
      origin: "agent",
      duration_seconds: 7,
    });
  });

  it("omits duration when the invocation never recorded a start time", async () => {
    await emitConnectionInvoked(
      fakeDb(invocationRow({ startedAt: null, status: "denied" }), connectionRow()),
      "inv-1",
    );
    expect(track.mock.calls[0]?.[1]).not.toHaveProperty("duration_seconds");
    expect(track.mock.calls[0]?.[1]).toMatchObject({ status: "denied" });
  });

  it("ignores in-flight statuses so approval waits never count as failures", async () => {
    await emitConnectionInvoked(
      fakeDb(invocationRow({ status: "awaiting_approval" }), connectionRow()),
      "inv-1",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores invocations without a connection or with a non-tool connection", async () => {
    await emitConnectionInvoked(
      fakeDb(invocationRow({ connectionId: null }), connectionRow()),
      "inv-1",
    );
    await emitConnectionInvoked(
      fakeDb(invocationRow(), connectionRow({ connectionPurpose: "channel" })),
      "inv-1",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("resolves without emitting when the invocation row is missing", async () => {
    await expect(
      emitConnectionInvoked(fakeDb(null, null), "inv-missing"),
    ).resolves.toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });

  it("reads nothing from the database while the event name is unregistered", async () => {
    isRegisteredEventName.mockReturnValue(false);
    const db = fakeDb(invocationRow(), connectionRow());
    await emitConnectionInvoked(db, "inv-1");
    expect(db.selectCalls()).toBe(0);
    expect(track).not.toHaveBeenCalled();
    expect(isRegisteredEventName).toHaveBeenCalledWith(
      "connection.invoked",
    );
  });

  it("loads the invocation and connection with a single read once registered", async () => {
    const db = fakeDb(invocationRow(), connectionRow());
    await emitConnectionInvoked(db, "inv-1");
    expect(db.selectCalls()).toBe(1);
    expect(track).toHaveBeenCalledTimes(1);
  });
});

describe("serverDomainForUrl", () => {
  it.each([
    ["https://mcp.smithery.ai/sse", "smithery.ai"],
    ["https://server.smithery.ai/@acme/tools/mcp?api_key=sk-live-123&profile=acme", "smithery.ai"],
    ["https://alice:hunter2@mcp.example.com:8443/v1/sse/3f9c2b7e-token?x=1#frag", "example.com"],
    ["http://acme-corp.mcp.example.co.uk/mcp", "example.co.uk"],
    ["https://MCP.Example.COM./sse", "example.com"],
    ["https://bücher.example.de/mcp", "example.de"],
    ["https://acme-tenant.github.io/mcp", "github.io"],
    ["https://my-app.vercel.app/api/mcp", "vercel.app"],
  ])("reduces %s to its registrable domain", (url, expected) => {
    expect(serverDomainForUrl(url)).toBe(expected);
  });

  it.each([
    "http://10.0.0.5:3000/mcp",
    "http://192.168.1.20/mcp",
    "http://127.0.0.1:8080/sse",
    "http://[::1]:8080/mcp",
    "http://[fd00::1]/mcp",
    "http://localhost:3000/mcp",
    "http://mcp.localhost/mcp",
    "http://printer.local/mcp",
    "https://tools.svc.internal/mcp",
    "https://nas.home.arpa/mcp",
    "http://abcdefghijklmnop.onion/mcp",
    "https://mcp.corp/mcp",
    "https://intranet/mcp",
    "https://foo.unknowntld/mcp",
    "ftp://files.example.com/mcp",
    "not a url",
    "",
    "   ",
    null,
    42,
    { url: "https://mcp.smithery.ai" },
  ])("reports %s as private", (value) => {
    expect(serverDomainForUrl(value)).toBe("private");
  });
});

describe("serverDomainForConnection", () => {
  it("omits the domain for catalog connectors, which already name their service", () => {
    expect(serverDomainForConnection(connectionRow({ config: { sourceTemplateKey: "github", url: "https://api.githubcopilot.com/mcp" } }))).toBeUndefined();
  });

  it("reports stdio for local servers and omits it for a remote server without an address", () => {
    expect(serverDomainForConnection(connectionRow({ transport: "local_stdio", config: { command: "npx" } }))).toBe("stdio");
    expect(serverDomainForConnection(connectionRow({ config: {} }))).toBeUndefined();
  });

  it("reads the remote address with the same precedence as the connection runtime", () => {
    expect(serverDomainForConnection(connectionRow({ config: { url: "https://a.example.com/x", endpoint: "https://b.example.org/y" } }))).toBe("example.com");
    expect(serverDomainForConnection(connectionRow({ config: { endpoint: "https://b.example.org/y", remoteUrl: "https://c.example.net/z" } }))).toBe("example.org");
    expect(serverDomainForConnection(connectionRow({ config: { remoteUrl: "https://c.example.net/z" } }))).toBe("example.net");
  });
});

describe("custom connector server_domain on connection events", () => {
  const secretUrl = "https://alice:hunter2@tenant-acme.mcp.smithery.ai:8443/v1/sse/tok_9f8e7d?api_key=sk-live-123";
  const custom = connectionRow({ config: { sourceTemplateKey: "my-internal-server", url: secretUrl } });

  it("adds only the registrable domain to created, updated, and invoked events", async () => {
    emitConnectionCreated(custom, "api");
    emitConnectionUpdated(custom, { status: "draft", enabled: true }, "api");
    await emitConnectionInvoked(fakeDb(invocationRow(), custom), "inv-1");
    expect(track.mock.calls.map(([name]) => name)).toEqual(["connection.created", "connection.updated", "connection.invoked"]);
    for (const [, dims] of track.mock.calls) {
      expect(dims).toMatchObject({ connector_key: "custom", server_domain: "smithery.ai" });
    }
    const payload = JSON.stringify(track.mock.calls);
    for (const leaked of ["https:", "//", "alice", "hunter2", "tenant-acme", "mcp.smithery", "8443", "/v1", "sse", "tok_9f8e7d", "api_key", "sk-live-123", "my-internal-server"]) {
      expect(payload).not.toContain(leaked);
    }
  });

  it("never adds server_domain to catalog connector events", () => {
    emitConnectionCreated(connectionRow({ config: { sourceTemplateKey: "github", url: secretUrl } }), "gallery");
    expect(track.mock.calls[0]?.[1]).not.toHaveProperty("server_domain");
  });

  it("reports private and stdio markers instead of local addresses", () => {
    emitConnectionCreated(connectionRow({ config: { url: "http://192.168.1.20:3000/mcp?token=abc" } }), "api");
    emitConnectionCreated(connectionRow({ transport: "local_stdio", config: { command: "/Users/alice/bin/mcp-server" } }), "api");
    expect(track.mock.calls.map(([, dims]) => dims.server_domain)).toEqual(["private", "stdio"]);
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/192\.168|token|alice/);
  });
});

describe("aggregatorAppTelemetrySlug", () => {
  it("keeps reviewed catalog slugs for every provider", () => {
    expect(aggregatorAppTelemetrySlug("composio", "github")).toBe("github");
    expect(aggregatorAppTelemetrySlug("arcade", "Gmail")).toBe("gmail");
    expect(aggregatorAppTelemetrySlug("executor", "notion")).toBe("notion");
  });

  it("reports other for toolkits outside the catalog and provider-supplied names", () => {
    for (const toolkit of ["acme-internal-crm", "Alice's Private Integration", "https://acme.example/app", "", "   ", null, 7]) {
      expect(aggregatorAppTelemetrySlug("composio", toolkit)).toBe("other");
      expect(aggregatorAppTelemetrySlug("arcade", toolkit)).toBe("other");
      expect(aggregatorAppTelemetrySlug("executor", toolkit)).toBe("other");
    }
  });

  it("only ever returns values the registered app pattern accepts", () => {
    for (const app of AGGREGATOR_APP_CATALOG) {
      for (const route of app.routes) {
        expect(aggregatorAppTelemetrySlug(route.provider, route.toolkit)).toMatch(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
      }
    }
  });
});

describe("newlyLinkedToolkits", () => {
  it("emits once on the transition to connected and never on a re-sync", () => {
    const previous = new Map([["github", "connected"], ["gmail", "not_connected"]]);
    expect(newlyLinkedToolkits(previous, [
      { toolkit: "github", status: "connected" },
      { toolkit: "gmail", status: "connected" },
      { toolkit: "notion", status: "connected" },
      { toolkit: "notion", status: "connected" },
      { toolkit: "slack", status: "not_connected" },
    ])).toEqual(["gmail", "notion"]);
    expect(newlyLinkedToolkits(new Map([["gmail", "connected"], ["notion", "connected"]]), [
      { toolkit: "gmail", status: "connected" },
      { toolkit: "notion", status: "connected" },
    ])).toEqual([]);
  });
});

describe("aggregator app events", () => {
  it("sends provider and catalog-or-other app only", () => {
    emitAggregatorAppsLinked("company-1", "composio", ["github", "acme-internal-crm"]);
    emitAggregatorAppsRequested("company-1", { provider: "arcade", toolkits: ["Gmail", "Gmail"], origin: "user", outcome: "needs_auth" });
    expect(track.mock.calls).toEqual([
      ["connection.app_linked", { provider: "composio", app: "github" }],
      ["connection.app_linked", { provider: "composio", app: "other" }],
      ["connection.app_requested", { provider: "arcade", app: "gmail", origin: "user", outcome: "needs_auth" }],
    ]);
  });

  it("never throws from telemetry", () => {
    track.mockImplementation(() => { throw new Error("sink offline"); });
    expect(() => emitAggregatorAppsLinked("company-1", "composio", ["github"])).not.toThrow();
    expect(() => emitAggregatorAppsRequested("company-1", { provider: "composio", toolkits: ["github"], origin: "agent", outcome: "failed" })).not.toThrow();
    telemetryClient = null;
    expect(() => emitAggregatorAppsLinked("company-1", "composio", ["github"])).not.toThrow();
  });

  it("reports agent Composio add requests with each app's own outcome and ignores other calls", () => {
    const response = { jsonrpc: "2.0", id: "1", result: { structuredContent: { data: { results: {
      github: { toolkit: "github", status: "ACTIVE" },
      gmail: { redirect_url: "https://connect.composio.dev/link/abc" },
      slack: { toolkit: "slack", status: "INITIATED" },
    } } } } };
    const call = { companyId: "company-1", provider: "composio", toolName: "COMPOSIO_MANAGE_CONNECTIONS", origin: "agent" as const, pendingAuthorization: true, response };
    emitAggregatorAppRequestsFromToolCall({ ...call, parameters: { toolkits: [
      { name: "github", action: "add" }, { name: "gmail", action: "add" }, { name: "notion", action: "list" }, { name: "acme-crm", action: "add" },
    ] } });
    expect(track.mock.calls).toEqual([
      ["connection.app_requested", { provider: "composio", app: "github", origin: "agent", outcome: "succeeded" }],
      ["connection.app_requested", { provider: "composio", app: "gmail", origin: "agent", outcome: "needs_auth" }],
      ["connection.app_requested", { provider: "composio", app: "other", origin: "agent", outcome: "failed" }],
    ]);
    track.mockClear();
    emitAggregatorAppRequestsFromToolCall({ ...call, parameters: { toolkits: [{ name: "github", action: "list" }] } });
    emitAggregatorAppRequestsFromToolCall({ ...call, toolName: "COMPOSIO_MULTI_EXECUTE_TOOL", parameters: { toolkits: [{ name: "github", action: "add" }] } });
    emitAggregatorAppRequestsFromToolCall({ ...call, origin: null, parameters: { toolkits: [{ name: "github", action: "add" }] } });
    expect(track).not.toHaveBeenCalled();
  });

  it("reports failed when the Composio response is an error or has no result for the app", () => {
    const call = { companyId: "company-1", provider: "composio", toolName: "COMPOSIO_MANAGE_CONNECTIONS", origin: "agent" as const, pendingAuthorization: false, parameters: { toolkits: [{ name: "slack", action: "add" }] } };
    emitAggregatorAppRequestsFromToolCall({ ...call, response: { jsonrpc: "2.0", id: "1", error: { code: -32000, message: "upstream failed" } } });
    emitAggregatorAppRequestsFromToolCall({ ...call, response: { jsonrpc: "2.0", id: "1", result: { isError: true, content: [] } } });
    emitAggregatorAppRequestsFromToolCall({ ...call, response: { jsonrpc: "2.0", id: "1", result: { structuredContent: { data: { results: {} } } } } });
    expect(track.mock.calls.map(([, dims]) => dims.outcome)).toEqual(["failed", "failed", "failed"]);
  });

  it("never lets a sibling's sign-in link or a top-level link mark another app as needs_auth", () => {
    const link = "https://connect.composio.dev/link/abc";
    const call = { companyId: "company-1", provider: "composio", toolName: "COMPOSIO_MANAGE_CONNECTIONS", origin: "agent" as const, pendingAuthorization: true };
    emitAggregatorAppRequestsFromToolCall({ ...call,
      parameters: { toolkits: [{ name: "gmail", action: "add" }, { name: "slack", action: "add" }] },
      response: { jsonrpc: "2.0", id: "1", result: { structuredContent: { data: { results: { gmail: { redirect_url: link }, slack: { toolkit: "slack", error: "not enabled" } } } } } } });
    emitAggregatorAppRequestsFromToolCall({ ...call,
      parameters: { toolkits: [{ name: "gmail", action: "add" }, { name: "slack", action: "add" }] },
      response: { jsonrpc: "2.0", id: "1", result: { structuredContent: { redirect_url: link } } } });
    emitAggregatorAppRequestsFromToolCall({ ...call,
      parameters: { toolkits: [{ name: "gmail", action: "add" }] },
      response: { jsonrpc: "2.0", id: "1", result: { structuredContent: { redirect_url: link } } } });
    expect(track.mock.calls.map(([, dims]) => `${dims.app}:${dims.outcome}`)).toEqual([
      "gmail:needs_auth", "slack:failed",
      "gmail:failed", "slack:failed",
      "gmail:needs_auth",
    ]);
  });

  it("reports an Arcade tool call that asks for authorization as a request for its toolkit", () => {
    const call = { companyId: "company-1", provider: "arcade", parameters: {}, response: {}, origin: "agent" as const };
    emitAggregatorAppRequestsFromToolCall({ ...call, toolName: "Gmail_SendEmail", pendingAuthorization: true });
    emitAggregatorAppRequestsFromToolCall({ ...call, toolName: "Gmail_SendEmail", pendingAuthorization: false });
    expect(track.mock.calls).toEqual([
      ["connection.app_requested", { provider: "arcade", app: "gmail", origin: "agent", outcome: "needs_auth" }],
    ]);
  });
});
