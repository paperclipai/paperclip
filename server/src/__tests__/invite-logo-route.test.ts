import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStorage = vi.hoisted(() => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => mockStorage,
}));

import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

function createSelectChain(rows: unknown[]) {
  const query = {
    leftJoin() {
      return query;
    },
    where() {
      return Promise.resolve(rows);
    },
  };
  return {
    from() {
      return query;
    },
  };
}

function createDbStub(inviteRows: unknown[], companyRows: unknown[]) {
  let selectCall = 0;
  return {
    select() {
      selectCall += 1;
      return selectCall === 1
        ? createSelectChain(inviteRows)
        : createSelectChain(companyRows);
    },
  };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "anon" };
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

describe("GET /invites/:token/logo", () => {
  beforeEach(() => {
    mockStorage.getObject.mockReset();
    mockStorage.headObject.mockReset();
  });

  it("serves the company logo for an active invite without company auth", async () => {
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
    mockStorage.headObject.mockResolvedValue({
      exists: true,
      contentType: "image/png",
      contentLength: 3,
    });
    mockStorage.getObject.mockResolvedValue({
      contentType: "image/png",
      contentLength: 3,
      stream: Readable.from([Buffer.from("png")]),
    });
    const app = createApp(
      createDbStub([invite], [{
        companyId: "company-1",
        objectKey: "assets/companies/logo-1",
        contentType: "image/png",
        byteSize: 3,
        originalFilename: "logo.png",
      }]),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(mockStorage.headObject).toHaveBeenCalledWith("company-1", "assets/companies/logo-1");
    expect(mockStorage.getObject).toHaveBeenCalledWith("company-1", "assets/companies/logo-1");
  });

  it("returns 404 when the logo asset record exists but storage does not", async () => {
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
    mockStorage.headObject.mockResolvedValue({ exists: false });
    const app = createApp(
      createDbStub([invite], [{
        companyId: "company-1",
        objectKey: "assets/companies/logo-1",
        contentType: "image/png",
        byteSize: 3,
        originalFilename: "logo.png",
      }]),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Invite logo not found");
    expect(mockStorage.getObject).not.toHaveBeenCalled();
  });
});
