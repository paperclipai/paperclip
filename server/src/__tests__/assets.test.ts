import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { Readable } from "node:stream";
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

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
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
    vi.clearAllMocks();
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG image uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "goals")
        .attach("file", Buffer.from("png"), "logo.png"),
    );

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

  it("accepts namespaces that hold identity-provider user ids", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const namespace = "profiles/oidc:example|jane.example@example.com";
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .field("namespace", namespace)
        .attach("file", Buffer.from("png"), "avatar.png"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(png.__calls.putFileInputs[0]).toMatchObject({
      companyId: "company-1",
      namespace: `assets/${namespace}`,
      originalFilename: "avatar.png",
      contentType: "image/png",
    });
  });

  it("rejects namespaces with characters outside the accepted set", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "profiles/bad name!")
        .attach("file", Buffer.from("png"), "avatar.png"),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("namespace");
    expect(res.body.details?.[0]?.path).toEqual(["namespace"]);
    expect(png.__calls.putFileInputs).toHaveLength(0);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects namespaces that hold a dot path segment", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "profiles/../secrets")
        .attach("file", Buffer.from("png"), "avatar.png"),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("namespace");
    expect(png.__calls.putFileInputs).toHaveLength(0);
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("allows supported non-image attachments outside the company logo flow", async () => {
    const text = createStorageService("text/plain");
    const app = await createApp(text);

    createAssetMock.mockResolvedValue({
      ...createAsset(),
      contentType: "text/plain",
      originalFilename: "note.txt",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .field("namespace", "issues/drafts")
        .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" }),
    );

    expect([200, 201]).toContain(res.status);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(res.body.contentType).toBe("text/plain");
  });

  it("names the limit in human units when a file exceeds the attachment cap", async () => {
    const app = await createApp(createStorageService());
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/assets/images")
        .attach("file", file, "too-large.png"),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("File is larger than the 10 MB limit");
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
    vi.clearAllMocks();
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG logo uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("png"), "logo.png"),
    );

    expect(res.status, JSON.stringify({ body: res.body, text: res.text, createCalls: createAssetMock.mock.calls.length })).toBe(201);
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

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach(
          "file",
          Buffer.from(
            "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
          ),
          "logo.svg",
        ),
    );

    expect(res.status, JSON.stringify({ body: res.body, text: res.text, createCalls: createAssetMock.mock.calls.length })).toBe(201);
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
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach("file", file, "within-limit.png"),
    );

    expect(res.status, JSON.stringify({ body: res.body, text: res.text, createCalls: createAssetMock.mock.calls.length })).toBe(201);
  });

  it("rejects logo files larger than the general attachment limit", async () => {
    const app = await createApp(createStorageService());
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach("file", file, "too-large.png"),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Image is larger than the 10 MB limit");
  });

  it("rejects unsupported image types", async () => {
    const app = await createApp(createStorageService("text/plain"));
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("not an image"), "note.txt"),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: text/plain");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects SVG image uploads that cannot be sanitized", async () => {
    const app = await createApp(createStorageService("image/svg+xml"));
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/logo")
        .attach("file", Buffer.from("not actually svg"), "logo.svg"),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SVG could not be sanitized");
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/assets/:assetId/content", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    getAssetByIdMock.mockReset();
  });

  it("downloads script-capable HTML with nosniff and a sandbox CSP", async () => {
    const html = Buffer.from("<script>globalThis.__assetXss = true</script>");
    const storage = createStorageService("text/html");
    getAssetByIdMock.mockResolvedValue({
      ...createAsset(),
      contentType: "text/html",
      byteSize: html.byteLength,
      originalFilename: "proof.html",
    });
    vi.mocked(storage.getObject).mockResolvedValue({
      stream: Readable.from(html),
      contentType: "text/html",
      contentLength: html.byteLength,
    });

    const res = await requestApp(await createApp(storage), (baseUrl) =>
      request(baseUrl).get("/api/assets/asset-1/content"),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="proof.html"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });

  it("downloads SVG instead of rendering it on the application origin", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>");
    const storage = createStorageService("image/svg+xml; charset=utf-8");
    getAssetByIdMock.mockResolvedValue({
      ...createAsset(),
      contentType: "image/svg+xml; charset=utf-8",
      byteSize: svg.byteLength,
      originalFilename: "logo.svg",
    });
    vi.mocked(storage.getObject).mockResolvedValue({
      stream: Readable.from(svg),
      contentType: "image/svg+xml; charset=utf-8",
      contentLength: svg.byteLength,
    });

    const res = await requestApp(await createApp(storage), (baseUrl) =>
      request(baseUrl).get("/api/assets/asset-1/content"),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="logo.svg"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });

  it("keeps curated image types inline", async () => {
    const image = Buffer.from("png-bytes");
    const storage = createStorageService("image/png");
    getAssetByIdMock.mockResolvedValue({
      ...createAsset(),
      byteSize: image.byteLength,
    });
    vi.mocked(storage.getObject).mockResolvedValue({
      stream: Readable.from(image),
      contentType: "image/png",
      contentLength: image.byteLength,
    });

    const res = await requestApp(await createApp(storage), (baseUrl) =>
      request(baseUrl).get("/api/assets/asset-1/content"),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('inline; filename="logo.png"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers).not.toHaveProperty("content-security-policy");
  });
});
