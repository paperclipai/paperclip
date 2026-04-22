import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStorage = vi.hoisted(() => ({
  headObject: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../storage/index.js", () => ({
    getStorageService: () => mockStorage,
  }));
}

function createSelectChain(rows: unknown[]) {
  const query = {
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    leftJoin() {
      return query;
    },
    orderBy() {
      return query;
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

function createDbStub(...selectResponses: unknown[][]) {
  let selectCall = 0;
  return {
    select() {
      const rows = selectResponses[selectCall] ?? [];
      selectCall += 1;
      return createSelectChain(rows);
    },
  };
}

async function createApp(
  db: Record<string, unknown>,
  actor: Record<string, unknown> = { type: "anon" },
) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("GET /invites/:token", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../storage/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    mockStorage.headObject.mockReset();
    mockStorage.headObject.mockResolvedValue({ exists: true, contentLength: 3, contentType: "image/png" });
  });

  it("returns company branding in the invite summary response", async () => {
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: "company-1",
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.companyBrandColor).toBe("#114488");
    expect(res.body.companyLogoUrl).toBe("/api/invites/pcp_invite_test/logo");
    expect(res.body.inviteType).toBe("company_join");
  });

  it("omits companyLogoUrl when the stored logo object is missing", async () => {
    mockStorage.headObject.mockResolvedValue({ exists: false });

    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: "company-1",
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyLogoUrl).toBeNull();
  });

  it("returns pending join-request status for an already-accepted invite", async () => {
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [{ requestType: "human", status: "pending_approval" }],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: "company-1",
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
    expect(res.body.companyName).toBe("Acme Robotics");
  });

  it("falls back to a reusable human join request when the accepted invite reused an existing queue entry", async () => {
    const invite = {
      id: "invite-2",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    };
    const reusableJoinRequest = {
      id: "join-1",
      requestType: "human",
      status: "pending_approval",
      requestingUserId: "user-1",
      requestEmailSnapshot: "jane@example.com",
    };
    const companyBranding = {
      name: "Acme Robotics",
      brandColor: "#114488",
      logoAssetId: "logo-1",
    };
    const logoAsset = {
      companyId: "company-1",
      objectKey: "company-1/assets/companies/logo-1",
      contentType: "image/png",
      byteSize: 3,
      originalFilename: "logo.png",
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [],
        [{ email: "jane@example.com" }],
        [reusableJoinRequest],
        [reusableJoinRequest],
        [companyBranding],
        [companyBranding],
        [logoAsset],
        [logoAsset],
      ),
      { type: "board", userId: "user-1", source: "session" },
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
  });
});
