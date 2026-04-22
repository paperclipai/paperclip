import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";

const { createAssetMock, getAssetByIdMock, logActivityMock } = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: logActivityMock,
  }));

  vi.doMock("../services/assets.js", () => ({
    assetService: vi.fn(() => ({
      create: createAssetMock,
      getById: getAssetByIdMock,
    })),
  }));

  vi.doMock("../services/index.js", () => ({
    assetService: vi.fn(() => ({
      create: createAssetMock,
      getById: getAssetByIdMock,
    })),
    logActivity: logActivityMock,
  }));
}

function createAsset() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "asset-1",
    companyId: "company-1",
    provider: "local",
    objectKey: "assets/abc",
    contentType: "image/png",
    byteSize: 40,
    sha256: "sha256-sample",
    originalFilename: "logo.png",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
  };
}

type TestStorageService = StorageService & {
  __calls: {
    putFileInputs: Array<{
      companyId: string;
      namespace: string;
      originalFilename: string | null;
      contentType: string;
      body: Buffer;
    }>;
  };
};

function createStorageService(contentType = "image/png"): TestStorageService {
  const calls: TestStorageService["__calls"] = { putFileInputs: [] };
  const putFile: StorageService["putFile"] = async (input: {
    companyId: string;
    namespace: string;
    originalFilename: string | null;
    contentType: string;
    body: Buffer;
  }) => {
    calls.putFileInputs.push(input);
    return {
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: contentType || input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    };
  };

  return {
    provider: "local_disk" as const,
    __calls: calls,
    putFile,
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

async function createApp(storage: ReturnType<typeof createStorageService>) {
  const { assetRoutes } = await vi.importActual<typeof import("../routes/assets.js")>("../routes/assets.js");
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

describe("POST /api/companies/:companyId/assets/images", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG image uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/companies/company-1/assets/images")
      .field("namespace", "goals")
      .attach("file", Buffer.from("png"), "logo.png");

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.__calls.putFileInputs[0]).toMatchObject({
      companyId: "company-1",
      namespace: "assets/goals",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("allows supported non-image attachments outside the company logo flow", async () => {
    const text = createStorageService("text/plain");
    const app = await createApp(text);

    createAssetMock.mockResolvedValue({
      ...createAsset(),
      contentType: "text/plain",
      originalFilename: "note.txt",
    });

    const res = await request(app)
      .post("/api/companies/company-1/assets/images")
      .field("namespace", "issues/drafts")
      .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });

    expect([200, 201]).toContain(res.status);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(res.body.contentType).toBe("text/plain");
  });
});

describe("POST /api/companies/:companyId/logo", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG logo uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("png"), "logo.png");

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.__calls.putFileInputs[0]).toMatchObject({
      companyId: "company-1",
      namespace: "assets/companies",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("sanitizes SVG logo uploads before storing them", async () => {
    const svg = createStorageService("image/svg+xml");
    const app = await createApp(svg);

    createAssetMock.mockResolvedValue({
      ...createAsset(),
      contentType: "image/svg+xml",
      originalFilename: "logo.svg",
    });

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
    expect(svg.__calls.putFileInputs).toHaveLength(1);
    const stored = svg.__calls.putFileInputs[0];
    expect(stored.contentType).toBe("image/svg+xml");
    expect(stored.originalFilename).toBe("logo.svg");
    const body = stored.body.toString("utf8");
    expect(body).toContain("<svg");
    expect(body).toContain("<circle");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onload=");
    expect(body).not.toContain("https://evil.example/");
  });

  it("allows logo uploads within the general attachment limit", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(150 * 1024, "a");
    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach("file", file, "within-limit.png");

    expect(res.status).toBe(201);
  });

  it("rejects logo files larger than the general attachment limit", async () => {
    const app = await createApp(createStorageService());
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach("file", file, "too-large.png");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  });

  it("rejects unsupported image types", async () => {
    const app = await createApp(createStorageService("text/plain"));
    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("not an image"), "note.txt");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: text/plain");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects SVG image uploads that cannot be sanitized", async () => {
    const app = await createApp(createStorageService("image/svg+xml"));
    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("not actually svg"), "logo.svg");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SVG could not be sanitized");
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});
