import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clipRoutes } from "../routes/clips.js";
import { errorHandler } from "../middleware/index.js";

const mockClipService = vi.hoisted(() => ({
  getPublicDetail: vi.fn(),
  getPublicRevision: vi.fn(),
  getCreatorPublicProfile: vi.fn(),
  publish: vi.fn(),
  getClipById: vi.fn(),
  createRevision: vi.fn(),
  updateClip: vi.fn(),
  createVote: vi.fn(),
  createReport: vi.fn(),
  createComment: vi.fn(),
  createShowcase: vi.fn(),
  recordImportTelemetry: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/clips.js", () => ({
  clipService: () => mockClipService,
}));

vi.mock("../services/index.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "board",
    };
    next();
  });
  app.use("/api", clipRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("clip routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed companyId path params before share-preview database lookups", async () => {
    const res = await request(createApp())
      .post("/api/companies/random-company-id/clips/share-preview")
      .send({ source: { type: "agent", id: "x" } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid companyId path parameter." });
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });
});
