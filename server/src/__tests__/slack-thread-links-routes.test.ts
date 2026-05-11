import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSlackThreadLinkService = vi.hoisted(() => ({
  create: vi.fn(),
  findByThreadTs: vi.fn(),
}));

// Local error class identity. The route imports SlackThreadLinkConflictError
// from services/index.js — we expose the same class instance here so
// `err instanceof SlackThreadLinkConflictError` works in tests.
class TestConflictError extends Error {
  readonly code = "SLACK_THREAD_LINK_CONFLICT" as const;
  readonly existing: unknown;
  constructor(existing: unknown) {
    super("conflict");
    this.existing = existing;
  }
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    slackThreadLinkService: () => mockSlackThreadLinkService,
    SlackThreadLinkConflictError: TestConflictError,
  }));
}

async function createApp(actor: any) {
  const [{ errorHandler }, { slackThreadLinkRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/slack-thread-links.js")>(
      "../routes/slack-thread-links.js",
    ),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", slackThreadLinkRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const otherCompanyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const sampleRow = {
  id: "11111111-1111-1111-1111-111111111111",
  companyId,
  threadTs: "1714492800.012345",
  channelId: "C0AKDLS6TQU",
  paperclipResourceType: "issue",
  paperclipResourceId: "22222222-2222-2222-2222-222222222222",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId,
  source: "agent_jwt",
};
const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [
    { companyId, membershipRole: "admin", status: "active" },
  ],
};
const anonymousActor = { type: "none", source: "none" };

describe("slack thread link routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/slack-thread-links.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSlackThreadLinkService.create.mockReset();
    mockSlackThreadLinkService.findByThreadTs.mockReset();
  });

  describe("POST /api/slack/thread-links", () => {
    it("creates a new link and returns 201 for an agent caller (companyId auto-derived)", async () => {
      mockSlackThreadLinkService.create.mockResolvedValue({ row: sampleRow, created: true });
      const app = await createApp(agentActor);

      const res = await request(app)
        .post("/api/slack/thread-links")
        .send({
          threadTs: sampleRow.threadTs,
          channelId: sampleRow.channelId,
          paperclipResourceType: sampleRow.paperclipResourceType,
          paperclipResourceId: sampleRow.paperclipResourceId,
        });

      expect(res.status).toBe(201);
      expect(res.body.threadTs).toBe(sampleRow.threadTs);
      expect(res.body.paperclipResourceId).toBe(sampleRow.paperclipResourceId);
      expect(res.body.companyId).toBe(companyId);
      expect(mockSlackThreadLinkService.create).toHaveBeenCalledWith({
        companyId,
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: sampleRow.paperclipResourceType,
        paperclipResourceId: sampleRow.paperclipResourceId,
      });
    });

    it("creates a new link for a board caller when companyId is supplied and access allowed", async () => {
      mockSlackThreadLinkService.create.mockResolvedValue({ row: sampleRow, created: true });
      const app = await createApp(boardActor);

      const res = await request(app)
        .post("/api/slack/thread-links")
        .send({
          companyId,
          threadTs: sampleRow.threadTs,
          channelId: sampleRow.channelId,
          paperclipResourceType: sampleRow.paperclipResourceType,
          paperclipResourceId: sampleRow.paperclipResourceId,
        });

      expect(res.status).toBe(201);
      expect(mockSlackThreadLinkService.create).toHaveBeenCalledWith({
        companyId,
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: sampleRow.paperclipResourceType,
        paperclipResourceId: sampleRow.paperclipResourceId,
      });
    });

    it("rejects a board caller that omits companyId with 403", async () => {
      const app = await createApp(boardActor);

      const res = await request(app)
        .post("/api/slack/thread-links")
        .send({
          threadTs: sampleRow.threadTs,
          channelId: sampleRow.channelId,
          paperclipResourceType: sampleRow.paperclipResourceType,
          paperclipResourceId: sampleRow.paperclipResourceId,
        });

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.create).not.toHaveBeenCalled();
    });

    it("rejects a board caller without access to the requested company with 403", async () => {
      const app = await createApp(boardActor);

      const res = await request(app)
        .post("/api/slack/thread-links")
        .send({
          companyId: otherCompanyId,
          threadTs: sampleRow.threadTs,
          channelId: sampleRow.channelId,
          paperclipResourceType: sampleRow.paperclipResourceType,
          paperclipResourceId: sampleRow.paperclipResourceId,
        });

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.create).not.toHaveBeenCalled();
    });

    it("rejects an agent caller that smuggles a different companyId with 403", async () => {
      const app = await createApp(agentActor);

      const res = await request(app)
        .post("/api/slack/thread-links")
        .send({
          companyId: otherCompanyId,
          threadTs: sampleRow.threadTs,
          channelId: sampleRow.channelId,
          paperclipResourceType: sampleRow.paperclipResourceType,
          paperclipResourceId: sampleRow.paperclipResourceId,
        });

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.create).not.toHaveBeenCalled();
    });

    it("returns 200 (not 201) when the link already exists with the same binding", async () => {
      mockSlackThreadLinkService.create.mockResolvedValue({ row: sampleRow, created: false });
      const app = await createApp(agentActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: "issue",
        paperclipResourceId: sampleRow.paperclipResourceId,
      });

      expect(res.status).toBe(200);
      expect(res.body.paperclipResourceId).toBe(sampleRow.paperclipResourceId);
    });

    it("returns 409 when the thread is already linked to a different resource", async () => {
      mockSlackThreadLinkService.create.mockRejectedValue(new TestConflictError(sampleRow));
      const app = await createApp(agentActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: "approval",
        paperclipResourceId: "33333333-3333-3333-3333-333333333333",
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already linked/i);
      expect(res.body.details.existing.paperclipResourceId).toBe(sampleRow.paperclipResourceId);
    });

    it("rejects unauthenticated callers with 401", async () => {
      const app = await createApp(anonymousActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: "issue",
        paperclipResourceId: sampleRow.paperclipResourceId,
      });

      expect(res.status).toBe(401);
      expect(mockSlackThreadLinkService.create).not.toHaveBeenCalled();
    });

    it("rejects payloads with a non-uuid paperclipResourceId", async () => {
      const app = await createApp(agentActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: "issue",
        paperclipResourceId: "not-a-uuid",
      });

      expect(res.status).toBe(400);
      expect(mockSlackThreadLinkService.create).not.toHaveBeenCalled();
    });

    it("rejects whitespace in threadTs", async () => {
      const app = await createApp(agentActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: "bad ts",
        channelId: sampleRow.channelId,
        paperclipResourceType: "issue",
        paperclipResourceId: sampleRow.paperclipResourceId,
      });

      expect(res.status).toBe(400);
    });

    it("rejects an uppercase / weird paperclipResourceType", async () => {
      const app = await createApp(agentActor);

      const res = await request(app).post("/api/slack/thread-links").send({
        threadTs: sampleRow.threadTs,
        channelId: sampleRow.channelId,
        paperclipResourceType: "Issue!",
        paperclipResourceId: sampleRow.paperclipResourceId,
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/slack/thread-links/:ts", () => {
    it("returns the link for an authenticated agent caller (companyId auto-scoped)", async () => {
      mockSlackThreadLinkService.findByThreadTs.mockResolvedValue(sampleRow);
      const app = await createApp(agentActor);

      const res = await request(app).get(`/api/slack/thread-links/${sampleRow.threadTs}`);

      expect(res.status).toBe(200);
      expect(res.body.paperclipResourceId).toBe(sampleRow.paperclipResourceId);
      expect(res.body.companyId).toBe(companyId);
      expect(mockSlackThreadLinkService.findByThreadTs).toHaveBeenCalledWith(
        companyId,
        sampleRow.threadTs,
        undefined,
      );
    });

    it("narrows the lookup by channel_id when supplied", async () => {
      mockSlackThreadLinkService.findByThreadTs.mockResolvedValue(sampleRow);
      const app = await createApp(boardActor);

      const res = await request(app).get(
        `/api/slack/thread-links/${sampleRow.threadTs}?channel_id=${sampleRow.channelId}&company_id=${companyId}`,
      );

      expect(res.status).toBe(200);
      expect(mockSlackThreadLinkService.findByThreadTs).toHaveBeenCalledWith(
        companyId,
        sampleRow.threadTs,
        sampleRow.channelId,
      );
    });

    it("returns 404 when no link exists", async () => {
      mockSlackThreadLinkService.findByThreadTs.mockResolvedValue(null);
      const app = await createApp(agentActor);

      const res = await request(app).get("/api/slack/thread-links/9999999999.000000");

      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated callers with 401", async () => {
      const app = await createApp(anonymousActor);

      const res = await request(app).get(`/api/slack/thread-links/${sampleRow.threadTs}`);

      expect(res.status).toBe(401);
      expect(mockSlackThreadLinkService.findByThreadTs).not.toHaveBeenCalled();
    });

    it("rejects a board caller that omits company_id with 403", async () => {
      const app = await createApp(boardActor);

      const res = await request(app).get(`/api/slack/thread-links/${sampleRow.threadTs}`);

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.findByThreadTs).not.toHaveBeenCalled();
    });

    it("rejects a board caller without access to the requested company with 403", async () => {
      const app = await createApp(boardActor);

      const res = await request(app).get(
        `/api/slack/thread-links/${sampleRow.threadTs}?company_id=${otherCompanyId}`,
      );

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.findByThreadTs).not.toHaveBeenCalled();
    });

    it("rejects an agent caller that smuggles a different company_id with 403", async () => {
      const app = await createApp(agentActor);

      const res = await request(app).get(
        `/api/slack/thread-links/${sampleRow.threadTs}?company_id=${otherCompanyId}`,
      );

      expect(res.status).toBe(403);
      expect(mockSlackThreadLinkService.findByThreadTs).not.toHaveBeenCalled();
    });

    it("rejects an invalid thread_ts in the path", async () => {
      const app = await createApp(agentActor);

      // express decodes the encoded space and the regex rejects it
      const res = await request(app).get("/api/slack/thread-links/bad%20ts");

      expect(res.status).toBe(400);
    });
  });
});
