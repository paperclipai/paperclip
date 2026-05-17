import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentLease } from "@paperclipai/shared";
import { sandboxRoutes, __testing as sandboxRoutesTesting } from "../routes/sandbox.js";
import { errorHandler } from "../middleware/index.js";
import {
  publishSandboxEvent,
  __sandboxSubscriberCount,
} from "../services/sandbox/events.js";

const mockListSandboxLeasesForCompany = vi.hoisted(() => vi.fn());
const mockGetSandboxLeaseForCompany = vi.hoisted(() => vi.fn());

vi.mock("../services/sandbox/queries.js", () => ({
  listSandboxLeasesForCompany: mockListSandboxLeasesForCompany,
  getSandboxLeaseForCompany: mockGetSandboxLeaseForCompany,
}));

// The docker provider must NEVER be invoked from the REST/SSE surface.
// Spy on `execute` so any accidental call would surface in test failures.
const mockDockerExecute = vi.hoisted(() => vi.fn());
vi.mock("../services/sandbox/docker-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/sandbox/docker-provider.js")>(
    "../services/sandbox/docker-provider.js",
  );
  // Patch the prototype so any unexpected execute() leaks become test failures.
  actual.DockerSandboxProvider.prototype.execute = mockDockerExecute as never;
  return actual;
});

const ORIGINAL_DOCKER_FLAG = process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;

const ACQUIRED_AT = new Date("2026-04-16T05:00:00.000Z");
const NOW = new Date("2026-05-16T05:00:00.000Z");

function buildLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "docker",
    providerLeaseId: "sandbox://docker/env-1/abc",
    acquiredAt: ACQUIRED_AT,
    lastUsedAt: NOW,
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: {
      provider: "docker",
      image: "node:20",
      reuseLease: false,
      sandboxState: "running",
      kind: "docker",
      capabilities: {
        rootless: true,
        dropAllCapabilities: true,
        seccompProfile: "default",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        cgroupsVersion: "v2",
        backdoor: "yes",
      },
      quotas: { cpuMillicores: 500, memoryBytes: 134217728, secretBudget: "$100" },
      network: {
        mode: "none",
        egressAllowlist: [],
        dnsAllowlist: [],
        allowLoopback: true,
        allowInboundPorts: [],
        backchannel: "10.0.0.1",
      },
      policyHash: "policy-hash-abc",
      env: { TOKEN: "secret-token-zzz" },
      command: "psql postgres://user:hunter2@db.internal/foo",
      destinationId: "destination-secret",
    },
    createdAt: ACQUIRED_AT,
    updatedAt: NOW,
    ...overrides,
  };
}

let server: Server | null = null;
let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
};

function buildApp(actor: Record<string, unknown>): express.Express {
  currentActor = actor;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: typeof currentActor }).actor = currentActor;
    next();
  });
  app.use("/api", sandboxRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("sandbox routes", () => {
  beforeEach(() => {
    mockListSandboxLeasesForCompany.mockReset();
    mockGetSandboxLeaseForCompany.mockReset();
    mockDockerExecute.mockReset();
    delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  afterAll(() => {
    if (ORIGINAL_DOCKER_FLAG === undefined) {
      delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
    } else {
      process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = ORIGINAL_DOCKER_FLAG;
    }
  });

  it("GET /companies/:companyId/sandbox/providers returns previewOnly snapshot", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/providers");
    expect(res.status).toBe(200);
    expect(res.body.previewOnly).toBe(true);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "docker", kind: "builtin", enabled: false, previewOnly: true }),
        expect.objectContaining({ provider: "fake", kind: "builtin", enabled: false, previewOnly: true }),
      ]),
    );
  });

  it("GET /sandbox/leases returns redacted read-model and never invokes Docker", async () => {
    mockListSandboxLeasesForCompany.mockResolvedValue([buildLease()]);
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases");
    expect(res.status).toBe(200);
    expect(res.body.previewOnly).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.leases[0].truth).toBe("preview"); // docker flag off
    expect(res.body.leases[0].capabilities).toEqual({
      rootless: true,
      dropAllCapabilities: true,
      seccompProfile: "default",
      readOnlyRootfs: true,
      noNewPrivileges: true,
      cgroupsVersion: "v2",
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("secret-token-zzz");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("destination-secret");
    expect(serialized).not.toContain("backdoor");
    expect(mockDockerExecute).not.toHaveBeenCalled();
  });

  it("GET /sandbox/leases reflects truth=backend-backed when docker flag is set", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    mockListSandboxLeasesForCompany.mockResolvedValue([buildLease()]);
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases");
    expect(res.status).toBe(200);
    expect(res.body.leases[0].truth).toBe("backend-backed");
    expect(res.body.leases[0].providerEnabled).toBe(true);
    expect(mockDockerExecute).not.toHaveBeenCalled();
  });

  it("rejects unknown lease status filter with INVALID_QUERY", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases?status=bogus");
    expect(res.status).toBe(400);
    expect(res.body.details?.code).toBe("SANDBOX_INVALID_QUERY");
  });

  it("rejects unsupported provider filter with PROVIDER_UNSUPPORTED", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases?provider=ghost");
    expect(res.status).toBe(404);
    expect(res.body.details?.code).toBe("SANDBOX_PROVIDER_UNSUPPORTED");
  });

  it("returns 404 with LEASE_NOT_FOUND code when lease missing", async () => {
    mockGetSandboxLeaseForCompany.mockResolvedValue(null);
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases/abc");
    expect(res.status).toBe(404);
    expect(res.body.details?.code).toBe("SANDBOX_LEASE_NOT_FOUND");
  });

  it("enforces company scoping for agent actors on a different company", async () => {
    const app = buildApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases");
    expect(res.status).toBe(403);
  });

  it("returns 401 when the actor is unauthenticated", async () => {
    const app = buildApp({ type: "none" });
    const res = await request(app).get("/api/companies/company-1/sandbox/leases");
    expect(res.status).toBe(401);
  });

  it("scopes lease lookups by company id (cross-company lease is 404)", async () => {
    mockGetSandboxLeaseForCompany.mockImplementation(async (_db, companyId: string) => {
      // Simulate the query honoring the companyId filter
      return companyId === "company-1" ? null : null;
    });
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    await request(app).get("/api/companies/company-1/sandbox/leases/lease-1");
    expect(mockGetSandboxLeaseForCompany).toHaveBeenCalledWith(expect.anything(), "company-1", "lease-1");
  });

  it("POST /sandbox/preview/validate validates a fake provider config without execution", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/preview/validate")
      .send({ provider: "fake", config: { image: "node:20", reuseLease: false } });
    expect(res.status).toBe(200);
    expect(res.body.previewOnly).toBe(true);
    expect(res.body.provider).toBe("fake");
    expect(res.body.validation.ok).toBe(true);
    expect(mockDockerExecute).not.toHaveBeenCalled();
  });

  it("POST /sandbox/preview/validate validates a docker config without invoking docker", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/preview/validate")
      .send({ provider: "docker", config: { image: "node:20", reuseLease: false } });
    expect(res.status).toBe(200);
    expect(res.body.previewOnly).toBe(true);
    expect(res.body.provider).toBe("docker");
    expect(res.body.validation.ok).toBe(true);
    expect(mockDockerExecute).not.toHaveBeenCalled();
  });

  it("rejects /sandbox/preview/validate with PROVIDER_UNSUPPORTED for unknown provider", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/preview/validate")
      .send({ provider: "ghost", config: {} });
    expect(res.status).toBe(404);
    expect(res.body.details?.code).toBe("SANDBOX_PROVIDER_UNSUPPORTED");
  });

  it("rejects /sandbox/preview/validate with POLICY_REJECTED on invalid docker config", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/preview/validate")
      .send({ provider: "docker", config: { image: "", reuseLease: false } });
    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("SANDBOX_POLICY_REJECTED");
  });

  it("rejects start/stop pseudo-routes with PREVIEW_ONLY", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const startRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/start");
    expect(startRes.status).toBe(409);
    expect(startRes.body.details?.code).toBe("SANDBOX_PREVIEW_ONLY");
    const stopRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/stop");
    expect(stopRes.status).toBe(409);
    expect(stopRes.body.details?.code).toBe("SANDBOX_PREVIEW_ONLY");
  });

  it("start/stop pseudo-routes return 401 for unauthenticated actors (not 409)", async () => {
    const app = buildApp({ type: "none" });
    const startRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/start");
    expect(startRes.status).toBe(401);
    expect(startRes.body.details?.code).not.toBe("SANDBOX_PREVIEW_ONLY");
    const stopRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/stop");
    expect(stopRes.status).toBe(401);
    expect(stopRes.body.details?.code).not.toBe("SANDBOX_PREVIEW_ONLY");
  });

  it("start/stop pseudo-routes return 403 for cross-company agents (not 409)", async () => {
    const app = buildApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const startRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/start");
    expect(startRes.status).toBe(403);
    expect(startRes.body.details?.code).not.toBe("SANDBOX_PREVIEW_ONLY");
    const stopRes = await request(app)
      .post("/api/companies/company-1/sandbox/leases/lease-1/stop");
    expect(stopRes.status).toBe(403);
    expect(stopRes.body.details?.code).not.toBe("SANDBOX_PREVIEW_ONLY");
  });

  it("GET /sandbox/events opens an SSE stream and delivers published events", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    const url = `http://127.0.0.1:${address.port}/api/companies/company-1/sandbox/events`;

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Read first chunk (ready event)
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const readChunk = async (): Promise<string> => {
      const { value, done } = await reader.read();
      if (done || !value) return "";
      return decoder.decode(value);
    };
    const first = await readChunk();
    expect(first).toContain(":ok");
    expect(first).toContain("event: sandbox.ready");

    // Wait until the subscriber is wired in (publish may race connection setup)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (__sandboxSubscriberCount("company-1") > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Publish — must deliver and must scrub secret patterns
    publishSandboxEvent({
      companyId: "company-1",
      type: "sandbox.lease.state_changed",
      payload: {
        leaseId: "lease-1",
        reason: "Bearer leaktoken123 password=hunter2",
      },
    });

    let received = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      received += await readChunk();
      if (received.includes("sandbox.lease.state_changed")) break;
    }
    expect(received).toContain("event: sandbox.lease.state_changed");
    expect(received).toContain("[REDACTED]");
    expect(received).not.toContain("hunter2");
    expect(received).not.toContain("leaktoken123");

    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Subscriber should be cleaned up after the client disconnects
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (__sandboxSubscriberCount("company-1") === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(__sandboxSubscriberCount("company-1")).toBe(0);
  });

  it("writeSseEvent returns false when res.write signals backpressure (so subscribers can clean up)", () => {
    // The cleanup chain in the SSE route depends on writeSseEvent returning
    // false when the kernel socket buffer is full. Prove that any false
    // res.write propagates, not just thrown errors.
    const writeCalls: string[] = [];
    const fakeRes = {
      writable: true,
      write: (chunk: string) => {
        writeCalls.push(chunk);
        // Simulate the 3rd write (data: …) returning false.
        return writeCalls.length < 3;
      },
    } as unknown as express.Response;

    const ok = sandboxRoutesTesting.writeSseEvent(fakeRes, {
      type: "sandbox.lease.state_changed",
      id: 1,
      data: { leaseId: "lease-1" },
    });
    expect(ok).toBe(false);
    expect(writeCalls.length).toBe(3);

    // And when res is no longer writable, return false without writing.
    const closedRes = { writable: false, write: vi.fn() } as unknown as express.Response;
    const okClosed = sandboxRoutesTesting.writeSseEvent(closedRes, {
      type: "sandbox.lease.state_changed",
      data: {},
    });
    expect(okClosed).toBe(false);
    expect((closedRes as unknown as { write: ReturnType<typeof vi.fn> }).write).not.toHaveBeenCalled();
  });

  it("SSE redacts sensitive payload keys (token/apiKey/env/destinationId/password) end-to-end", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    const url = `http://127.0.0.1:${address.port}/api/companies/company-1/sandbox/events`;

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const readChunk = async (): Promise<string> => {
      const { value, done } = await reader.read();
      if (done || !value) return "";
      return decoder.decode(value);
    };
    // Drain the ready frame.
    await readChunk();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (__sandboxSubscriberCount("company-1") > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    publishSandboxEvent({
      companyId: "company-1",
      type: "sandbox.lease.state_changed",
      payload: {
        leaseId: "lease-1",
        token: "raw-token-aaaa",
        apiKey: "raw-apikey-bbbb",
        password: "raw-password-cccc",
        env: { SECRET_THING: "raw-env-dddd" },
        destinationId: "raw-destination-eeee",
        nested: { credential: "raw-cred-ffff", proxy: { user: "u", pass: "raw-proxy-gggg" } },
        summary: "ok",
      },
    });

    let received = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      received += await readChunk();
      if (received.includes("sandbox.lease.state_changed")) break;
    }
    expect(received).toContain("event: sandbox.lease.state_changed");
    expect(received).not.toContain("raw-token-aaaa");
    expect(received).not.toContain("raw-apikey-bbbb");
    expect(received).not.toContain("raw-password-cccc");
    expect(received).not.toContain("raw-env-dddd");
    expect(received).not.toContain("raw-destination-eeee");
    expect(received).not.toContain("raw-cred-ffff");
    expect(received).not.toContain("raw-proxy-gggg");
    expect(received).toContain("[REDACTED]");

    controller.abort();
    await reader.cancel().catch(() => undefined);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (__sandboxSubscriberCount("company-1") === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(__sandboxSubscriberCount("company-1")).toBe(0);
  });

  it("SSE refuses cross-company access", async () => {
    const app = buildApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    const url = `http://127.0.0.1:${address.port}/api/companies/company-1/sandbox/events`;
    const response = await fetch(url);
    expect(response.status).toBe(403);
    await response.body?.cancel().catch(() => undefined);
  });
});
