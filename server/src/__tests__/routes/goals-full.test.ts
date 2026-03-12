import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalRoutes } from "../../routes/goals.js";
import { errorHandler } from "../../middleware/index.js";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("goalRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /companies/:companyId/goals", () => {
    it("lists goals", async () => {
      mockGoalService.list.mockResolvedValue([{ id: "g1", title: "Goal 1" }]);
      const res = await request(createApp()).get("/api/companies/company-1/goals");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/goals");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /goals/:id", () => {
    it("returns a goal", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "company-1", title: "Goal 1" });
      const res = await request(createApp()).get("/api/goals/g1");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Goal 1");
    });

    it("returns 404 for nonexistent goal", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/goals/missing");
      expect(res.status).toBe(404);
    });

    it("returns 403 when goal belongs to different company", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "other-company", title: "Goal 1" });
      const res = await request(createApp()).get("/api/goals/g1");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /companies/:companyId/goals", () => {
    it("creates a goal", async () => {
      mockGoalService.create.mockResolvedValue({ id: "g2", companyId: "company-1", title: "New Goal" });
      const res = await request(createApp())
        .post("/api/companies/company-1/goals")
        .send({ title: "New Goal" });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe("New Goal");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "goal.created" }),
      );
    });
  });

  describe("PATCH /goals/:id", () => {
    it("updates a goal", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "company-1" });
      mockGoalService.update.mockResolvedValue({ id: "g1", companyId: "company-1", title: "Updated" });
      const res = await request(createApp())
        .patch("/api/goals/g1")
        .send({ title: "Updated" });
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "goal.updated" }),
      );
    });

    it("returns 404 when goal not found", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/goals/missing")
        .send({ title: "Updated" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when update returns null", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "company-1" });
      mockGoalService.update.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/goals/g1")
        .send({ title: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /goals/:id", () => {
    it("deletes a goal", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "company-1" });
      mockGoalService.remove.mockResolvedValue({ id: "g1", companyId: "company-1", title: "Deleted" });
      const res = await request(createApp()).delete("/api/goals/g1");
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "goal.deleted" }),
      );
    });

    it("returns 404 when goal not found for delete", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/goals/missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when remove returns null", async () => {
      mockGoalService.getById.mockResolvedValue({ id: "g1", companyId: "company-1" });
      mockGoalService.remove.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/goals/g1");
      expect(res.status).toBe(404);
    });
  });
});
