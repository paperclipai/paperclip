import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const deliverableId = "33333333-3333-4333-8333-333333333333";
const childIssueId = "11111111-1111-4111-8111-111111111111";
const rootIssueId = "44444444-4444-4444-8444-444444444444";
const middleIssueId = "55555555-5555-4555-8555-555555555555";
const agentId = "66666666-6666-4666-8666-666666666666";
const runId = "77777777-7777-4777-8777-777777777777";

const mockWorkProductService = vi.hoisted(() => ({
  listDeliverablesForCompany: vi.fn(),
  getDeliverableById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  workProductService: () => mockWorkProductService,
  clampDeliverableLimit: (value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(Math.floor(n), 200);
  },
}));

import { deliverableRoutes } from "../routes/deliverables.js";

function createApp(actorOverride?: Partial<{ companyIds: string[] }>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: actorOverride?.companyIds ?? [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", deliverableRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function sampleDeliverable(overrides: Record<string, unknown> = {}) {
  return {
    id: deliverableId,
    companyId,
    projectId: null,
    title: "Final report",
    summary: null,
    createdAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
    contentPath: "/api/attachments/abc/content",
    contentType: "application/pdf",
    byteSize: 1024,
    originalFilename: "report.pdf",
    childIssue: { id: childIssueId, identifier: "PAP-12", title: "Write report", status: "done" },
    rootIssue: { id: rootIssueId, identifier: "PAP-1", title: "Quarterly review", status: "in_progress" },
    agent: { id: agentId, name: "Astro", icon: null },
    runId,
    ...overrides,
  };
}

describe("deliverables routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/deliverables", () => {
    it("returns artifact deliverables for the company", async () => {
      mockWorkProductService.listDeliverablesForCompany.mockResolvedValue([sampleDeliverable()]);

      const res = await request(createApp()).get(`/api/companies/${companyId}/deliverables`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [sampleDeliverable()],
        limit: 50,
        offset: 0,
      });
      expect(mockWorkProductService.listDeliverablesForCompany).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ limit: 50, offset: 0 }),
      );
    });

    it("clamps the requested limit and forwards filters", async () => {
      mockWorkProductService.listDeliverablesForCompany.mockResolvedValue([]);

      await request(createApp()).get(
        `/api/companies/${companyId}/deliverables?limit=999&offset=10&projectId=p1&agentId=${agentId}&q=draft`,
      );

      expect(mockWorkProductService.listDeliverablesForCompany).toHaveBeenCalledWith(
        companyId,
        {
          limit: 200,
          offset: 10,
          projectId: "p1",
          agentId,
          q: "draft",
        },
      );
    });

    it("forbids access to a company the actor does not belong to", async () => {
      const res = await request(createApp({ companyIds: [otherCompanyId] })).get(
        `/api/companies/${companyId}/deliverables`,
      );
      expect(res.status).toBe(403);
      expect(mockWorkProductService.listDeliverablesForCompany).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/deliverables/:id", () => {
    it("returns the deliverable with ancestor chain", async () => {
      const ancestors = [
        { id: middleIssueId, identifier: "PAP-7", title: "Middle", status: "in_progress" },
        { id: rootIssueId, identifier: "PAP-1", title: "Quarterly review", status: "in_progress" },
      ];
      mockWorkProductService.getDeliverableById.mockResolvedValue({
        ...sampleDeliverable(),
        ancestors,
      });

      const res = await request(createApp()).get(`/api/deliverables/${deliverableId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(deliverableId);
      expect(res.body.rootIssue.id).toBe(rootIssueId);
      expect(res.body.childIssue.id).toBe(childIssueId);
      expect(res.body.agent.id).toBe(agentId);
      expect(res.body.ancestors).toEqual(ancestors);
    });

    it("returns 404 when the deliverable does not exist", async () => {
      mockWorkProductService.getDeliverableById.mockResolvedValue(null);

      const res = await request(createApp()).get(`/api/deliverables/${deliverableId}`);
      expect(res.status).toBe(404);
    });

    it("forbids access when the deliverable belongs to another company", async () => {
      mockWorkProductService.getDeliverableById.mockResolvedValue({
        ...sampleDeliverable({ companyId: otherCompanyId }),
        ancestors: [],
      });

      const res = await request(createApp()).get(`/api/deliverables/${deliverableId}`);
      expect(res.status).toBe(403);
    });
  });
});
