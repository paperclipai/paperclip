import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientRoutes } from "../routes/clients.js";
import { errorHandler } from "../middleware/index.js";

const mockClientService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockClientInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  resolveEntryContent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  clientService: () => mockClientService,
  clientInstructionsService: () => mockClientInstructionsService,
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", clientRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("client instructions routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientService.getById.mockResolvedValue({
      id: "client-1",
      companyId: "company-1",
      name: "Acme",
    });
    mockClientInstructionsService.getBundle.mockResolvedValue({
      clientId: "client-1",
      companyId: "company-1",
      rootPath: "/tmp/client-1",
      entryFile: "CLIENT.md",
      files: [],
    });
    mockClientInstructionsService.readFile.mockResolvedValue({
      path: "CLIENT.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      content: "hello",
    });
    mockClientInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "CLIENT.md",
        size: 5,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        content: "",
      },
    });
    mockClientInstructionsService.deleteFile.mockResolvedValue({
      bundle: {
        clientId: "client-1",
        companyId: "company-1",
        rootPath: "/tmp/client-1",
        entryFile: "CLIENT.md",
        files: [],
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await request(createApp()).get("/api/clients/client-1/instructions-bundle");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      clientId: "client-1",
      companyId: "company-1",
      entryFile: "CLIENT.md",
    });
    expect(mockClientInstructionsService.getBundle).toHaveBeenCalledWith("company-1", "client-1");
  });

  it("writes a client instructions file and logs activity", async () => {
    const res = await request(createApp())
      .put("/api/clients/client-1/instructions-bundle/file")
      .send({ path: "CLIENT.md", content: "" });

    expect(res.status).toBe(200);
    expect(mockClientInstructionsService.writeFile).toHaveBeenCalledWith("company-1", "client-1", "CLIENT.md", "");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        entityType: "client",
        entityId: "client-1",
        action: "client.instructions_file_updated",
      }),
    );
  });

  it("requires a path query param when reading a file", async () => {
    const res = await request(createApp()).get("/api/clients/client-1/instructions-bundle/file");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Query parameter 'path' is required");
  });
});
