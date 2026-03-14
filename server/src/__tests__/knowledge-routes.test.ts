import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { knowledgeRoutes } from "../routes/knowledge.js";

const mockKnowledgeService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  knowledgeService: () => mockKnowledgeService,
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", knowledgeRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("knowledge routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists documents for a company with query filters", async () => {
    mockKnowledgeService.list.mockResolvedValue([
      {
        id: "doc-1",
        companyId: "company-1",
        title: "Architecture decisions",
      },
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/knowledge-documents?q=arch");

    expect(res.status).toBe(200);
    expect(mockKnowledgeService.list).toHaveBeenCalledWith("company-1", { q: "arch" });
    expect(res.body).toEqual([{ id: "doc-1", companyId: "company-1", title: "Architecture decisions" }]);
  });

  it("creates a document and writes an activity log entry", async () => {
    mockKnowledgeService.create.mockResolvedValue({
      id: "doc-2",
      companyId: "company-1",
      title: "Runtime guide",
      category: "operations",
      tags: ["runtime"],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/knowledge-documents")
      .send({
        title: "Runtime guide",
        category: "operations",
        tags: ["runtime"],
        content: "Use the embedded Postgres for local runs.",
      });

    expect(res.status).toBe(201);
    expect(mockKnowledgeService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Runtime guide",
      category: "operations",
      tags: ["runtime"],
      createdByUserId: "user-1",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "knowledge_document.created",
      entityId: "doc-2",
    }));
  });
});