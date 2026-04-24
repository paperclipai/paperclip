import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createSelectChain(rows: unknown[]) {
  const query = {
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    where() {
      return query;
    },
  };
  return {
    from() {
      return query;
    },
  };
}

function createDbStub(inviteRows: unknown[]) {
  return {
    select() {
      return createSelectChain(inviteRows);
    },
  };
}

function createInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    tokenHash: "hash",
    defaultsPayload: null,
    expiresAt: new Date("2027-03-07T00:10:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    ...overrides,
  };
}

let currentAccessModule: Awaited<ReturnType<typeof vi.importActual<typeof import("../routes/access.js")>>> | null = null;

async function createApp(
  db: Record<string, unknown>,
  network: {
    lookup: ReturnType<typeof vi.fn>;
    requestHead: ReturnType<typeof vi.fn>;
  },
) {
  const [access, middleware] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  currentAccessModule = access;
  access.setInviteResolutionNetworkForTest(network);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "anon" };
    next();
  });
  app.use(
    "/api",
    access.accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(middleware.errorHandler);
  return app;
}

describe.sequential("GET /invites/:token/test-resolution", () => {
  beforeEach(() => {
    currentAccessModule = null;
  });

  afterEach(async () => {
    currentAccessModule?.setInviteResolutionNetworkForTest(null);
  });

  it.each([
    ["localhost", "http://localhost:3100/api/health", "127.0.0.1"],
    ["IPv4 loopback", "http://127.0.0.1:3100/api/health", "127.0.0.1"],
    ["IPv6 loopback", "http://[::1]:3100/api/health", "::1"],
    ["IPv4-mapped IPv6 loopback hex", "http://[::ffff:7f00:1]/api/health", "::ffff:7f00:1"],
    ["IPv4-mapped IPv6 RFC1918 hex", "http://[::ffff:c0a8:101]/api/health", "::ffff:c0a8:101"],
    ["RFC1918 10/8", "http://10.0.0.5/api/health", "10.0.0.5"],
    ["RFC1918 172.16/12", "http://172.16.10.5/api/health", "172.16.10.5"],
    ["RFC1918 192.168/16", "http://192.168.1.10/api/health", "192.168.1.10"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["multicast", "http://224.0.0.1/probe", "224.0.0.1"],
    ["NAT64 well-known prefix", "https://gateway.example.test/health", "64:ff9b::0a00:0001"],
    ["NAT64 local-use prefix", "https://gateway.example.test/health", "64:ff9b:1::0a00:0001"],
  ])("rejects %s targets before probing", async (_label, url, address) => {
    const lookup = vi.fn().mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    const requestHead = vi.fn();
    const app = await createApp(createDbStub([createInvite()]), { lookup, requestHead });

    const res = await request(app)
      .get("/api/invites/pcp_invite_test/test-resolution")
      .query({ url });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "url resolves to a private, local, multicast, or reserved address",
    );
    expect(requestHead).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects hostnames that resolve to private addresses", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const requestHead = vi.fn();
    const app = await createApp(createDbStub([createInvite()]), { lookup, requestHead });

    const res = await request(app)
      .get("/api/invites/pcp_invite_test/test-resolution")
      .query({ url: "https://gateway.example.test/health" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "url resolves to a private, local, multicast, or reserved address",
    );
    expect(lookup).toHaveBeenCalledWith("gateway.example.test");
    expect(requestHead).not.toHaveBeenCalled();
  });

  it("rejects hostnames when any resolved address is private", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    const requestHead = vi.fn();
    const app = await createApp(createDbStub([createInvite()]), { lookup, requestHead });

    const res = await request(app)
      .get("/api/invites/pcp_invite_test/test-resolution")
      .query({ url: "https://mixed.example.test/health" });

    expect(res.status).toBe(400);
    expect(requestHead).not.toHaveBeenCalled();
  });

  it("allows public HTTPS targets through the resolved and pinned probe path", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const requestHead = vi.fn().mockResolvedValue({ httpStatus: 204 });
    const app = await createApp(createDbStub([createInvite()]), { lookup, requestHead });

    const res = await request(app)
      .get("/api/invites/pcp_invite_test/test-resolution")
      .query({ url: "https://gateway.example.test/health", timeoutMs: "2500" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      inviteId: "invite-1",
      requestedUrl: "https://gateway.example.test/health",
      timeoutMs: 2500,
      status: "reachable",
      method: "HEAD",
      httpStatus: 204,
    });
    expect(requestHead).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedAddress: "93.184.216.34",
        resolvedAddresses: ["93.184.216.34"],
        hostHeader: "gateway.example.test",
        tlsServername: "gateway.example.test",
      }),
      2500,
    );
  });

  it.each([
    ["missing invite", []],
    ["revoked invite", [createInvite({ revokedAt: new Date("2026-03-07T00:05:00.000Z") })]],
    ["expired invite", [createInvite({ expiresAt: new Date("2020-03-07T00:10:00.000Z") })]],
  ])("returns not found for %s tokens before DNS lookup", async (_label, inviteRows) => {
    const lookup = vi.fn();
    const requestHead = vi.fn();
    const app = await createApp(createDbStub(inviteRows), { lookup, requestHead });

    const res = await request(app)
      .get("/api/invites/pcp_invite_test/test-resolution")
      .query({ url: "https://gateway.example.test/health" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Invite not found");
    expect(lookup).not.toHaveBeenCalled();
    expect(requestHead).not.toHaveBeenCalled();
  });
});
