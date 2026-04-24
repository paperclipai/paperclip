import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { assetRoutes } from "../routes/assets.js";
import { errorHandler } from "../middleware/index.js";
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

function createStorageService(contentType = "image/png"): StorageService {
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

function createApp(storage: ReturnType<typeof createStorageService>) {
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
  app.use(errorHandler);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

describe("POST /api/companies/:companyId/assets/images", () => {
  afterEach(() => {
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG image uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestWithApp(createApp(png), (agent) =>
      agent
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "goals")
        .attach("file", Buffer.from("png"), "logo.png")
    );

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.putFile).toHaveBeenCalledWith({
      companyId: "company-1",
      namespace: "assets/goals",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("allows supported non-image attachments outside the company logo flow", async () => {
    const text = createStorageService("text/plain");

    createAssetMock.mockResolvedValue({
      ...createAsset(),
      contentType: "text/plain",
      originalFilename: "note.txt",
    });

    const res = await requestWithApp(createApp(text), (agent) =>
      agent
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "issues/drafts")
        .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" })
    );

    expect(res.status).toBe(201);
    expect(text.putFile).toHaveBeenCalledWith({
      companyId: "company-1",
      namespace: "assets/issues/drafts",
      originalFilename: "note.txt",
      contentType: "text/plain",
      body: expect.any(Buffer),
    });
  });
});

describe("POST /api/companies/:companyId/logo", () => {
  afterEach(() => {
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG logo uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestWithApp(createApp(png), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("png"), "logo.png")
    );

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.putFile).toHaveBeenCalledWith({
      companyId: "company-1",
      namespace: "assets/companies",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("sanitizes SVG logo uploads before storing them", async () => {
    const svg = createStorageService("image/svg+xml");

    createAssetMock.mockResolvedValue({
      ...createAsset(),
      contentType: "image/svg+xml",
      originalFilename: "logo.svg",
    });

    const res = await requestWithApp(createApp(svg), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach(
        "file",
        Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
        ),
        "logo.svg",
        )
    );

    expect(res.status).toBe(201);
    expect(svg.putFile).toHaveBeenCalledTimes(1);
    const stored = (svg.putFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
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
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(150 * 1024, "a");
    const res = await requestWithApp(createApp(png), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach("file", file, "within-limit.png")
    );

    expect(res.status).toBe(201);
  });

  it("rejects logo files larger than the general attachment limit", async () => {
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await requestWithApp(createApp(createStorageService()), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach("file", file, "too-large.png")
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  });

  it("rejects unsupported image types", async () => {
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestWithApp(createApp(createStorageService("text/plain")), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("not an image"), "note.txt")
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: text/plain");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects SVG image uploads that cannot be sanitized", async () => {
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestWithApp(createApp(createStorageService("image/svg+xml")), (agent) =>
      agent
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("not actually svg"), "logo.svg")
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SVG could not be sanitized");
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});
