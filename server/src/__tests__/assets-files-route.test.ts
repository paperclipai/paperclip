import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assetRoutes } from "../routes/assets.js";
import { errorHandler } from "../middleware/index.js";

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  assetService: () => mockAssetService,
  logActivity: mockLogActivity,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function createApp(actor: Record<string, unknown>, storageOverrides?: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    assetRoutes(
      {} as any,
      {
        putFile: vi.fn().mockResolvedValue({
          provider: "local_disk",
          objectKey: "assets/records/report.txt",
          contentType: "text/plain",
          byteSize: 5,
          sha256: "abc123",
          originalFilename: "report.txt",
        }),
        getObject: vi.fn().mockResolvedValue({
          contentType: "text/plain",
          contentLength: 5,
          stream: Readable.from([Buffer.from("hello")]),
        }),
        ...storageOverrides,
      } as any,
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("asset file routes", () => {
  beforeEach(() => {
    mockAssetService.create.mockReset();
    mockAssetService.getById.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("uploads generic files for record attachments", async () => {
    mockAssetService.create.mockResolvedValue({
      id: "asset-1",
      companyId: COMPANY_ID,
      provider: "local_disk",
      objectKey: "assets/records/report.txt",
      contentType: "text/plain",
      byteSize: 5,
      sha256: "abc123",
      originalFilename: "report.txt",
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdAt: new Date("2026-03-08T10:00:00.000Z"),
      updatedAt: new Date("2026-03-08T10:00:00.000Z"),
    });

    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/assets/files`)
      .field("namespace", "records")
      .attach("file", Buffer.from("hello"), {
        filename: "report.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(res.body.assetId).toBe("asset-1");
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(mockAssetService.create).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "asset.created",
        entityType: "asset",
      }),
    );
  });

  it("denies generic file uploads across company boundaries", async () => {
    const app = createApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: "99999999-9999-4999-8999-999999999999",
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/assets/files`)
      .attach("file", Buffer.from("hello"), {
        filename: "report.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another company");
    expect(mockAssetService.create).not.toHaveBeenCalled();
  });

  it("rejects active-content file uploads", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/assets/files`)
      .attach("file", Buffer.from("<html><script>alert(1)</script></html>"), {
        filename: "report.html",
        contentType: "text/html",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Unsupported file type");
    expect(mockAssetService.create).not.toHaveBeenCalled();
  });

  it("serves asset content with nosniff headers", async () => {
    mockAssetService.getById.mockResolvedValue({
      id: "asset-1",
      companyId: COMPANY_ID,
      provider: "local_disk",
      objectKey: "assets/records/report.txt",
      contentType: "text/plain",
      byteSize: 5,
      sha256: "abc123",
      originalFilename: "report.txt",
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdAt: new Date("2026-03-08T10:00:00.000Z"),
      updatedAt: new Date("2026-03-08T10:00:00.000Z"),
    });
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/assets/asset-1/content");

    expect(res.status).toBe(200);
    expect(res.header["x-content-type-options"]).toBe("nosniff");
  });
});
