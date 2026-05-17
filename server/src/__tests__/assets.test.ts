import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";

const { canUserMock, createAssetMock, getAssetByIdMock, getAgentByIdMock, hasPermissionMock, logActivityMock } = vi.hoisted(() => ({
  canUserMock: vi.fn(),
  createAssetMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  getAgentByIdMock: vi.fn(),
  hasPermissionMock: vi.fn(),
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
    accessService: vi.fn(() => ({
      canUser: canUserMock,
      hasPermission: hasPermissionMock,
    })),
    agentService: vi.fn(() => ({
      getById: getAgentByIdMock,
    })),
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

function createDbStub(agent: { id: string; companyId: string } | null = { id: "agent-1", companyId: "company-1" }) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(agent ? [agent] : [])),
      })),
    })),
  };
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lNQ2NwAAAABJRU5ErkJggg==",
  "base64",
);

async function createApp(
  storage: ReturnType<typeof createStorageService>,
  db: Record<string, unknown> = {},
  actor: Express.Request["actor"] = {
    type: "board",
    source: "local_implicit",
    userId: "user-1",
  },
) {
  const { assetRoutes } = await vi.importActual<typeof import("../routes/assets.js")>("../routes/assets.js");
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", assetRoutes(db as any, storage));
  app.use(errorHandler);
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
    canUserMock.mockReset();
    getAssetByIdMock.mockReset();
    getAgentByIdMock.mockReset();
    hasPermissionMock.mockReset();
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
    canUserMock.mockReset();
    getAssetByIdMock.mockReset();
    getAgentByIdMock.mockReset();
    hasPermissionMock.mockReset();
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
    expect(res.body.error).toBe(`Image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
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

describe("POST /api/companies/:companyId/agents/:agentId/avatar", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    createAssetMock.mockReset();
    canUserMock.mockReset();
    getAssetByIdMock.mockReset();
    getAgentByIdMock.mockReset();
    hasPermissionMock.mockReset();
    logActivityMock.mockReset();
    getAgentByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    hasPermissionMock.mockResolvedValue(false);
    canUserMock.mockResolvedValue(false);
  });

  it("accepts decoded PNG avatar uploads for an agent in the company", async () => {
    const png = createStorageService("image/png");
    const app = await createApp(png, createDbStub());

    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", ONE_PIXEL_PNG, { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status, JSON.stringify({ body: res.body, text: res.text })).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(png.__calls.putFileInputs[0]).toMatchObject({
      companyId: "company-1",
      namespace: "assets/agents/agent-1/avatar",
      originalFilename: "avatar.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("rejects spoofed avatar images that cannot be decoded", async () => {
    const app = await createApp(createStorageService("image/png"), createDbStub());
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", Buffer.from("not really png"), { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Image could not be decoded");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("reports the avatar size limit in megabytes", async () => {
    const app = await createApp(createStorageService("image/png"), createDbStub());
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", Buffer.alloc((5 * 1024 * 1024) + 1), { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Image exceeds 5 MB");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects avatar uploads for agents outside the route company", async () => {
    const app = await createApp(createStorageService("image/png"), createDbStub({ id: "agent-1", companyId: "company-2" }));
    getAgentByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "company-2",
      role: "engineer",
      permissions: { canCreateAgents: false },
    });
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", ONE_PIXEL_PNG, { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects agent-key uploads for another agent without creator permission", async () => {
    const app = await createApp(
      createStorageService("image/png"),
      createDbStub(),
      {
        type: "agent",
        source: "agent_key",
        agentId: "agent-2",
        companyId: "company-1",
      },
    );
    getAgentByIdMock.mockImplementation(async (id: string) => {
      if (id === "agent-1") {
        return {
          id: "agent-1",
          companyId: "company-1",
          role: "engineer",
          permissions: { canCreateAgents: false },
        };
      }
      if (id === "agent-2") {
        return {
          id: "agent-2",
          companyId: "company-1",
          role: "engineer",
          permissions: { canCreateAgents: false },
        };
      }
      return null;
    });
    hasPermissionMock.mockResolvedValue(false);
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", ONE_PIXEL_PNG, { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only CEO or agent creators can modify other agents");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it("rejects board uploads without agent-management permission", async () => {
    const app = await createApp(
      createStorageService("image/png"),
      createDbStub(),
      {
        type: "board",
        source: "session",
        userId: "user-2",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      },
    );
    canUserMock.mockResolvedValue(false);
    createAssetMock.mockResolvedValue(createAsset());

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents/agent-1/avatar")
        .attach("file", ONE_PIXEL_PNG, { filename: "avatar.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: agents:create");
    expect(createAssetMock).not.toHaveBeenCalled();
  });
});
