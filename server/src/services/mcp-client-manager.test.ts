import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  assertMcpEndpointAllowed,
  createTransportForTarget,
  McpClientManagerError,
  mcpClientManager,
  type McpClientManagerOptions,
  type McpClientTarget,
  type McpWireClient,
} from "./mcp-client-manager.js";

// Endpoints use public IP literals (TEST-NET) so the SSRF guard never needs
// DNS in unit tests.
const PUBLIC_ENDPOINT = "http://203.0.113.10/mcp";

function httpTarget(overrides: Partial<McpClientTarget> = {}): McpClientTarget {
  return {
    companyId: "company-a",
    mcpServerId: "server-1",
    transport: "http",
    endpoint: PUBLIC_ENDPOINT,
    ...overrides,
  };
}

interface FakeWireClient extends McpWireClient {
  target: McpClientTarget;
  closed: boolean;
  pingError: Error | null;
  pingNeverResolves: boolean;
}

function fakeFactory() {
  const created: FakeWireClient[] = [];
  const connect = async (target: McpClientTarget): Promise<McpWireClient> => {
    const client: FakeWireClient = {
      target,
      closed: false,
      pingError: null,
      pingNeverResolves: false,
      async listTools() {
        if (client.pingNeverResolves) return new Promise(() => {});
        if (client.pingError) throw client.pingError;
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
      async close() {
        client.closed = true;
      },
    };
    created.push(client);
    return client;
  };
  return { created, connect };
}

function testManager(overrides: McpClientManagerOptions = {}) {
  const factory = fakeFactory();
  let nowMs = 0;
  const manager = mcpClientManager({
    reapIntervalMs: 0,
    healthCheckIntervalMs: 0,
    ttlMs: 10_000,
    idleMs: 5_000,
    now: () => nowMs,
    connectClient: factory.connect,
    ...overrides,
  });
  return {
    manager,
    factory,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("mcp-client-manager transports", () => {
  it("resolves the official SDK client import surface", () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    expect(client).toBeInstanceOf(Client);
  });

  it("constructs SDK transports for http and sse targets", () => {
    expect(createTransportForTarget(httpTarget())).toBeDefined();
    expect(
      createTransportForTarget(httpTarget({ transport: "sse", headers: { Authorization: "Bearer x" } })),
    ).toBeDefined();
  });

  it("rejects http/sse targets without an endpoint", () => {
    expect(() => createTransportForTarget(httpTarget({ endpoint: undefined }))).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );
  });
});

describe("mcp-client-manager SSRF guard", () => {
  it.each([
    "http://127.0.0.1:8080/mcp",
    "http://10.1.2.3/mcp",
    "http://192.168.1.5/mcp",
    "http://172.16.0.1/mcp",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.7/mcp",
    "http://0.0.0.0/mcp",
    "http://[::1]/mcp",
    "http://[fd00::1]/mcp",
    "http://[fe80::1]/mcp",
    "http://[::ffff:10.0.0.1]/mcp",
    "http://localhost:3000/mcp",
    "http://gateway.internal/mcp",
    "http://printer.local/mcp",
  ])("denies internal endpoint %s", async (endpoint) => {
    await expect(assertMcpEndpointAllowed(endpoint)).rejects.toMatchObject({
      code: "endpoint_denied",
    });
  });

  it("denies non-http protocols and rejects malformed URLs", async () => {
    await expect(assertMcpEndpointAllowed("ftp://203.0.113.10/")).rejects.toMatchObject({
      code: "endpoint_denied",
    });
    await expect(assertMcpEndpointAllowed("not a url")).rejects.toMatchObject({
      code: "invalid_target",
    });
  });

  it("allows public IP endpoints and private ones only under the explicit override", async () => {
    await expect(assertMcpEndpointAllowed(PUBLIC_ENDPOINT)).resolves.toBeInstanceOf(URL);
    await expect(
      assertMcpEndpointAllowed("http://127.0.0.1:9/mcp", { allowPrivateEndpoints: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("enforces the guard at the pool boundary before connecting", async () => {
    const { manager, factory } = testManager();
    await expect(
      manager.acquire(httpTarget({ endpoint: "http://169.254.169.254/latest" })),
    ).rejects.toMatchObject({ code: "endpoint_denied" });
    expect(factory.created).toHaveLength(0);
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });
  });
});

describe("mcp-client-manager pooling & tenant isolation", () => {
  it("connects lazily and reuses the pooled client per (company, server)", async () => {
    const { manager, factory } = testManager();
    const first = await manager.acquire(httpTarget());
    const again = await manager.acquire(httpTarget());
    expect(again).toBe(first);
    expect(factory.created).toHaveLength(1);
    expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
  });

  it("dedupes concurrent connects to the same key", async () => {
    const { manager, factory } = testManager();
    const [a, b] = await Promise.all([manager.acquire(httpTarget()), manager.acquire(httpTarget())]);
    expect(a).toBe(b);
    expect(factory.created).toHaveLength(1);
  });

  it("isolates companies: same server id yields distinct clients per company", async () => {
    const { manager, factory } = testManager();
    const a = await manager.acquire(httpTarget({ companyId: "company-a" }));
    const b = await manager.acquire(httpTarget({ companyId: "company-b" }));
    expect(a.client).not.toBe(b.client);
    expect(manager.stats()).toEqual({ companies: 2, clients: 2 });
    expect(factory.created).toHaveLength(2);
  });

  it("invalidating company A closes only A's clients; B is untouched", async () => {
    const { manager, factory } = testManager();
    await manager.acquire(httpTarget({ companyId: "company-a" }));
    await manager.acquire(httpTarget({ companyId: "company-a", mcpServerId: "server-2" }));
    const b = await manager.acquire(httpTarget({ companyId: "company-b" }));

    await manager.invalidateCompany("company-a");

    expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
    const [a1, a2, bClient] = factory.created;
    expect(a1.closed).toBe(true);
    expect(a2.closed).toBe(true);
    expect(bClient.closed).toBe(false);
    // B's pooled entry is still served without reconnecting.
    expect(await manager.acquire(httpTarget({ companyId: "company-b" }))).toBe(b);
    expect(factory.created).toHaveLength(3);
  });

  it("invalidateServer drops exactly one pooled entry", async () => {
    const { manager, factory } = testManager();
    await manager.acquire(httpTarget({ mcpServerId: "server-1" }));
    await manager.acquire(httpTarget({ mcpServerId: "server-2" }));
    await manager.invalidateServer("company-a", "server-1");
    expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
    expect(factory.created[0].closed).toBe(true);
    expect(factory.created[1].closed).toBe(false);
  });

  it("refuses stdio targets at the pool boundary while stdio is gated", async () => {
    const { manager } = testManager();
    const target = httpTarget({ transport: "stdio", endpoint: undefined, command: "evil" });
    await expect(manager.acquire(target)).rejects.toThrowError(
      expect.objectContaining({ name: "McpClientManagerError", code: "stdio_gated" }),
    );
  });
});

describe("mcp-client-manager TTL eviction & idle reaping", () => {
  it("reap evicts entries past their TTL and the next acquire reconnects", async () => {
    const { manager, factory, advance } = testManager({ ttlMs: 1_000, idleMs: 60_000 });
    await manager.acquire(httpTarget());
    advance(500);
    expect(await manager.reap()).toBe(0);
    advance(600);
    expect(await manager.reap()).toBe(1);
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });
    expect(factory.created[0].closed).toBe(true);

    await manager.acquire(httpTarget());
    expect(factory.created).toHaveLength(2);
  });

  it("reap evicts idle entries even when the TTL has headroom", async () => {
    const { manager, factory, advance } = testManager({ ttlMs: 60_000, idleMs: 1_000 });
    await manager.acquire(httpTarget());
    advance(800);
    await manager.acquire(httpTarget()); // touch keeps it alive
    advance(800);
    expect(await manager.reap()).toBe(0);
    advance(300);
    expect(await manager.reap()).toBe(1);
    expect(factory.created[0].closed).toBe(true);
  });

  it("acquire itself replaces an expired entry instead of serving it", async () => {
    const { manager, factory, advance } = testManager({ ttlMs: 1_000, idleMs: 60_000 });
    const first = await manager.acquire(httpTarget());
    advance(1_500);
    const second = await manager.acquire(httpTarget());
    expect(second).not.toBe(first);
    expect(factory.created[0].closed).toBe(true);
    expect(factory.created).toHaveLength(2);
  });
});

describe("mcp-client-manager health state machine", () => {
  it("keeps healthy clients pooled after a successful ping", async () => {
    const { manager, factory } = testManager();
    const entry = await manager.acquire(httpTarget());
    expect(await manager.checkHealth()).toEqual({ checked: 1, evicted: 0 });
    expect(entry.health).toBe("healthy");
    expect(factory.created[0].closed).toBe(false);
  });

  it("marks failing clients unhealthy, evicts them, and lazily reconnects", async () => {
    const { manager, factory } = testManager();
    const entry = await manager.acquire(httpTarget());
    factory.created[0].pingError = new Error("boom");

    expect(await manager.checkHealth()).toEqual({ checked: 1, evicted: 1 });
    expect(entry.health).toBe("unhealthy");
    expect(factory.created[0].closed).toBe(true);
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });

    const reconnected = await manager.acquire(httpTarget());
    expect(reconnected.health).toBe("healthy");
    expect(factory.created).toHaveLength(2);
  });

  it("treats a hung health ping as unhealthy via the ping timeout", async () => {
    const { manager, factory } = testManager({ healthCheckTimeoutMs: 20 });
    await manager.acquire(httpTarget());
    factory.created[0].pingNeverResolves = true;
    expect(await manager.checkHealth()).toEqual({ checked: 1, evicted: 1 });
    expect(factory.created[0].closed).toBe(true);
  });
});

describe("mcp-client-manager connect failures & lifecycle", () => {
  it("maps connect timeouts and failures to typed errors and allows retry", async () => {
    const hanging = mcpClientManager({
      reapIntervalMs: 0,
      healthCheckIntervalMs: 0,
      connectTimeoutMs: 20,
      connectClient: () => new Promise<never>(() => {}),
    });
    await expect(hanging.acquire(httpTarget())).rejects.toMatchObject({ code: "connect_timeout" });

    let attempts = 0;
    const flaky = mcpClientManager({
      reapIntervalMs: 0,
      healthCheckIntervalMs: 0,
      connectClient: async (target) => {
        attempts += 1;
        if (attempts === 1) throw new Error("ECONNREFUSED");
        return (await fakeFactory().connect(target)) as McpWireClient;
      },
    });
    await expect(flaky.acquire(httpTarget())).rejects.toMatchObject({ code: "connect_failed" });
    // The failed in-flight connect is cleared, so a retry connects fresh.
    await expect(flaky.acquire(httpTarget())).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("shutdown closes everything and the manager stays usable", async () => {
    const { manager, factory } = testManager();
    await manager.acquire(httpTarget({ companyId: "company-a" }));
    await manager.acquire(httpTarget({ companyId: "company-b" }));
    await manager.shutdown();
    expect(manager.stats()).toEqual({ companies: 0, clients: 0 });
    expect(factory.created.every((client) => client.closed)).toBe(true);

    await manager.acquire(httpTarget());
    expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
    await manager.shutdown();
  });

  it("exposes typed manager errors", () => {
    const error = new McpClientManagerError("endpoint_denied", "nope");
    expect(error.name).toBe("McpClientManagerError");
    expect(error.code).toBe("endpoint_denied");
  });
});

// ---------------------------------------------------------------------------
// stdio D2-7 — gate, concurrency cap, backoff
// ---------------------------------------------------------------------------

function stdioTarget(overrides: Partial<McpClientTarget> = {}): McpClientTarget {
  return {
    companyId: "company-a",
    mcpServerId: "stdio-server-1",
    transport: "stdio",
    command: "/usr/bin/echo",
    args: ["hello"],
    env: { MCP_CREDENTIAL: "s3cr3t" },
    cwd: "/tmp",
    ...overrides,
  };
}

describe("mcp-client-manager stdio gate (D2-7)", () => {
  it("blocks stdio when stdioEnabled is false (default)", async () => {
    const { manager } = testManager();
    await expect(manager.acquire(stdioTarget())).rejects.toMatchObject({
      code: "stdio_gated",
    });
  });

  it("blocks stdio with no command even when stdioEnabled=true", async () => {
    const { manager } = testManager({ stdioEnabled: true });
    await expect(
      manager.acquire(stdioTarget({ command: undefined })),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("connects stdio when stdioEnabled=true and command is present", async () => {
    const { manager } = testManager({ stdioEnabled: true });
    const entry = await manager.acquire(stdioTarget());
    expect(entry.transport).toBe("stdio");
    expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
  });

  it("constructs a stdio transport without throwing", () => {
    expect(() =>
      createTransportForTarget(stdioTarget()),
    ).not.toThrow();
  });

  it("rejects a stdio target without command via createTransportForTarget", () => {
    expect(() =>
      createTransportForTarget(stdioTarget({ command: undefined })),
    ).toThrowError(expect.objectContaining({ code: "invalid_target" }));
  });

  it("enforces per-company concurrency cap", async () => {
    const { manager } = testManager({ stdioEnabled: true, stdioMaxPerCompany: 2 });
    // acquire 2 — fills the cap
    await manager.acquire(stdioTarget({ mcpServerId: "s1" }));
    await manager.acquire(stdioTarget({ mcpServerId: "s2" }));
    // third should be denied
    await expect(manager.acquire(stdioTarget({ mcpServerId: "s3" }))).rejects.toMatchObject({
      code: "stdio_concurrency_limit",
    });
    expect(manager.stats()).toEqual({ companies: 1, clients: 2 });
  });

  it("releases a concurrency slot on eviction and allows a new connection", async () => {
    const { manager } = testManager({ stdioEnabled: true, stdioMaxPerCompany: 1 });
    await manager.acquire(stdioTarget({ mcpServerId: "s1" }));
    // currently at cap
    await expect(manager.acquire(stdioTarget({ mcpServerId: "s2" }))).rejects.toMatchObject({
      code: "stdio_concurrency_limit",
    });
    await manager.invalidateServer("company-a", "s1");
    // slot freed — should succeed now
    await expect(manager.acquire(stdioTarget({ mcpServerId: "s2" }))).resolves.toBeDefined();
  });

  it("enforces connect backoff after a failed stdio connect", async () => {
    let nowMs = 0;
    let attempts = 0;
    const manager = mcpClientManager({
      reapIntervalMs: 0,
      healthCheckIntervalMs: 0,
      stdioEnabled: true,
      stdioConnectBackoffMs: 5_000,
      now: () => nowMs,
      connectClient: async (target) => {
        attempts += 1;
        if (target.transport === "stdio") throw new Error("spawn failed");
        return (await fakeFactory().connect(target)) as McpWireClient;
      },
    });
    // First attempt fails, backoff is set
    await expect(manager.acquire(stdioTarget())).rejects.toMatchObject({ code: "connect_failed" });
    expect(attempts).toBe(1);
    // Immediate retry hits backoff
    await expect(manager.acquire(stdioTarget())).rejects.toMatchObject({ code: "stdio_backoff" });
    expect(attempts).toBe(1);
    // After backoff window passes, retry is allowed
    nowMs += 6_000;
    await expect(manager.acquire(stdioTarget())).rejects.toMatchObject({ code: "connect_failed" });
    expect(attempts).toBe(2);
  });

  it("clears backoff on successful connect", async () => {
    let nowMs = 0;
    let shouldFail = true;
    const manager = mcpClientManager({
      reapIntervalMs: 0,
      healthCheckIntervalMs: 0,
      stdioEnabled: true,
      stdioConnectBackoffMs: 5_000,
      now: () => nowMs,
      connectClient: async (target) => {
        if (target.transport === "stdio" && shouldFail) throw new Error("spawn failed");
        return (await fakeFactory().connect(target)) as McpWireClient;
      },
    });
    // fail to set backoff
    await expect(manager.acquire(stdioTarget())).rejects.toMatchObject({ code: "connect_failed" });
    // advance past backoff
    nowMs += 6_000;
    shouldFail = false;
    // success clears the backoff
    await expect(manager.acquire(stdioTarget())).resolves.toBeDefined();
    // immediate retry is now fine (no backoff)
    await manager.invalidateServer("company-a", "stdio-server-1");
    await expect(manager.acquire(stdioTarget())).resolves.toBeDefined();
  });
});
