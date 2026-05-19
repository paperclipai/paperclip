import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const linkId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockExternalLinkService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  deleteById: vi.fn(),
  lookupByPlatformKey: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const sampleIssue = {
  id: issueId,
  companyId,
  identifier: "PAP-981",
  title: "Test issue",
  status: "in_progress",
};

const sampleLink = {
  id: linkId,
  issueId,
  platform: "jira",
  externalKey: "PD-1234",
  externalUrl: "https://jira.example.com/browse/PD-1234",
  metadata: {},
  companyId,
  createdAt: new Date("2026-05-18T00:00:00.000Z"),
  updatedAt: new Date("2026-05-18T00:00:00.000Z"),
};

function registerModuleMocks() {
  vi.doMock("../services/external-links.js", () => ({
    externalLinkService: () => mockExternalLinkService,
  }));

  vi.doMock("../services/index.js", () => ({
    issueService: () => mockIssueService,
  }));
}

async function createApp() {
  const [{ externalLinksRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/external-links.js")>("../routes/external-links.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", externalLinksRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("external links routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/external-links.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  describe("POST /api/issues/:issueId/external-links", () => {
    it("creates a link and returns 201", async () => {
      mockIssueService.getById.mockResolvedValue(sampleIssue);
      mockExternalLinkService.create.mockResolvedValue(sampleLink);

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/external-links`)
        .send({
          platform: "jira",
          externalKey: "PD-1234",
          externalUrl: "https://jira.example.com/browse/PD-1234",
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: linkId, platform: "jira", externalKey: "PD-1234" });
      expect(mockExternalLinkService.create).toHaveBeenCalledWith(issueId, {
        platform: "jira",
        externalKey: "PD-1234",
        externalUrl: "https://jira.example.com/browse/PD-1234",
      });
    });

    it("returns 404 when issue does not exist", async () => {
      mockIssueService.getById.mockResolvedValue(null);

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/external-links`)
        .send({
          platform: "jira",
          externalKey: "PD-1234",
          externalUrl: "https://jira.example.com/browse/PD-1234",
        });

      expect(res.status).toBe(404);
      expect(mockExternalLinkService.create).not.toHaveBeenCalled();
    });

    it("returns 409 when duplicate link exists", async () => {
      mockIssueService.getById.mockResolvedValue(sampleIssue);
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockExternalLinkService.create.mockRejectedValue(new HttpError(409, "A link for this platform and key already exists on this issue"));

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/external-links`)
        .send({
          platform: "jira",
          externalKey: "PD-1234",
          externalUrl: "https://jira.example.com/browse/PD-1234",
        });

      expect(res.status).toBe(409);
    });

    it("returns 400 for invalid platform", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/external-links`)
        .send({
          platform: "unknown-tracker",
          externalKey: "X-1",
          externalUrl: "https://example.com",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/issues/:issueId/external-links", () => {
    it("returns list of links", async () => {
      mockIssueService.getById.mockResolvedValue(sampleIssue);
      mockExternalLinkService.listForIssue.mockResolvedValue([sampleLink]);

      const app = await createApp();
      const res = await request(app).get(`/api/issues/${issueId}/external-links`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ platform: "jira", externalKey: "PD-1234" });
    });

    it("returns 404 when issue does not exist", async () => {
      mockIssueService.getById.mockResolvedValue(null);

      const app = await createApp();
      const res = await request(app).get(`/api/issues/${issueId}/external-links`);

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/external-links/:linkId", () => {
    it("deletes the link and returns 204", async () => {
      mockExternalLinkService.getById.mockResolvedValue(sampleLink);
      mockExternalLinkService.deleteById.mockResolvedValue(undefined);

      const app = await createApp();
      const res = await request(app).delete(`/api/external-links/${linkId}`);

      expect(res.status).toBe(204);
      expect(mockExternalLinkService.deleteById).toHaveBeenCalledWith(linkId);
    });

    it("returns 404 when link does not exist", async () => {
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockExternalLinkService.getById.mockRejectedValue(new HttpError(404, "External link not found"));

      const app = await createApp();
      const res = await request(app).delete(`/api/external-links/${linkId}`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/external-links/lookup", () => {
    it("returns the link for a known platform+key", async () => {
      mockExternalLinkService.lookupByPlatformKey.mockResolvedValue(sampleLink);

      const app = await createApp();
      const res = await request(app)
        .get("/api/external-links/lookup")
        .query({ platform: "jira", externalKey: "PD-1234" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ issueId, platform: "jira", externalKey: "PD-1234" });
      expect(mockExternalLinkService.lookupByPlatformKey).toHaveBeenCalledWith("jira", "PD-1234");
    });

    it("returns 404 when no link exists", async () => {
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockExternalLinkService.lookupByPlatformKey.mockRejectedValue(new HttpError(404, "External link not found"));

      const app = await createApp();
      const res = await request(app)
        .get("/api/external-links/lookup")
        .query({ platform: "jira", externalKey: "PD-9999" });

      expect(res.status).toBe(404);
    });

    it("returns 400 for missing query parameters", async () => {
      const app = await createApp();
      const res = await request(app).get("/api/external-links/lookup");

      expect(res.status).toBe(400);
    });

    it("returns 400 for unsupported platform", async () => {
      const app = await createApp();
      const res = await request(app)
        .get("/api/external-links/lookup")
        .query({ platform: "notion", externalKey: "ABC-1" });

      expect(res.status).toBe(400);
    });
  });

  describe("integration: POST → GET → DELETE → GET", () => {
    it("creates, reads, deletes, and verifies empty", async () => {
      mockIssueService.getById.mockResolvedValue(sampleIssue);
      mockExternalLinkService.create.mockResolvedValue(sampleLink);
      mockExternalLinkService.listForIssue
        .mockResolvedValueOnce([sampleLink])
        .mockResolvedValueOnce([]);
      mockExternalLinkService.getById.mockResolvedValue(sampleLink);
      mockExternalLinkService.deleteById.mockResolvedValue(undefined);

      const app = await createApp();

      const postRes = await request(app)
        .post(`/api/issues/${issueId}/external-links`)
        .send({
          platform: "jira",
          externalKey: "PD-1234",
          externalUrl: "https://jira.example.com/browse/PD-1234",
        });
      expect(postRes.status).toBe(201);

      const getRes = await request(app).get(`/api/issues/${issueId}/external-links`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toHaveLength(1);

      const deleteRes = await request(app).delete(`/api/external-links/${linkId}`);
      expect(deleteRes.status).toBe(204);

      const emptyRes = await request(app).get(`/api/issues/${issueId}/external-links`);
      expect(emptyRes.status).toBe(200);
      expect(emptyRes.body).toHaveLength(0);
    });
  });
});
