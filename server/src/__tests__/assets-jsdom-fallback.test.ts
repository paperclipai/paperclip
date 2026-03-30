import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { StorageService } from "../storage/types.js";

const { createAssetMock, getAssetByIdMock, logActivityMock } = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  assetService: vi.fn(() => ({
    create: createAssetMock,
    getById: getAssetByIdMock,
  })),
  logActivity: logActivityMock,
}));

function createAsset() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "asset-1",
    companyId: "company-1",
    provider: "local",
    objectKey: "assets/abc",
    contentType: "image/svg+xml",
    byteSize: 40,
    sha256: "sha256-sample",
    originalFilename: "logo.svg",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
  };
}

function createStorageService(contentType = "image/svg+xml"): StorageService {
  const putFile: StorageService["putFile"] = vi.fn(async (input: {
    companyId: string;
    namespace: string;
    originalFilename: string | null;
    contentType: string;
    body: Buffer;
  }) => {
    return {
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: contentType || input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    };
  });

  return {
    provider: "local_disk" as const,
    putFile,
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

async function createApp(storage: StorageService) {
  const { assetRoutes } = await import("../routes/assets.js");
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", assetRoutes({} as any, storage));
  return app;
}

describe("asset routes jsdom fallback", () => {
  afterEach(() => {
    vi.doUnmock("jsdom");
    vi.resetModules();
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("sanitizes SVG uploads with the string fallback when jsdom cannot load", async () => {
    vi.doMock("jsdom", () => {
      throw new Error("synthetic jsdom loader failure");
    });

    const storage = createStorageService();
    const app = await createApp(storage);
    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach(
        "file",
        Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
        ),
        "logo.svg",
      );

    expect(res.status).toBe(201);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    const stored = (storage.putFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(stored.contentType).toBe("image/svg+xml");
    expect(stored.originalFilename).toBe("logo.svg");
    const body = stored.body.toString("utf8");
    expect(body).toContain("<svg");
    expect(body).toContain("<circle");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onload=");
    expect(body).not.toContain("https://evil.example/");
  });
});
