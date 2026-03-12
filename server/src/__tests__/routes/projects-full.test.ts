import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRoutes } from "../../routes/projects.js";
import { errorHandler } from "../../middleware/index.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  listByIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  projectService: () => mockProjectService,
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
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("projectRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /companies/:companyId/projects", () => {
    it("lists projects", async () => {
      mockProjectService.list.mockResolvedValue([{ id: "p1", name: "Alpha" }]);
      const res = await request(createApp()).get("/api/companies/company-1/projects");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/projects");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /projects/:id", () => {
    it("returns a project", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1", name: "Alpha" });
      const res = await request(createApp()).get("/api/projects/p1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Alpha");
    });

    it("returns 404 for nonexistent project", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/projects/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:companyId/projects", () => {
    it("creates a project", async () => {
      mockProjectService.create.mockResolvedValue({ id: "p2", companyId: "company-1", name: "Beta" });
      const res = await request(createApp())
        .post("/api/companies/company-1/projects")
        .send({ name: "Beta" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Beta");
    });
  });

  describe("PATCH /projects/:id", () => {
    it("updates a project", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.update.mockResolvedValue({ id: "p1", companyId: "company-1", name: "Updated" });
      const res = await request(createApp())
        .patch("/api/projects/p1")
        .send({ name: "Updated" });
      expect(res.status).toBe(200);
    });

    it("returns 404 if project does not exist", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/projects/missing")
        .send({ name: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /projects/:id", () => {
    it("deletes a project", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.remove.mockResolvedValue({ id: "p1", companyId: "company-1", name: "Alpha" });
      const res = await request(createApp()).delete("/api/projects/p1");
      expect(res.status).toBe(200);
    });

    it("returns 404 if project does not exist for delete", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/projects/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /projects/:id/workspaces", () => {
    it("lists workspaces for a project", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.listWorkspaces.mockResolvedValue([{ id: "w1", name: "main" }]);
      const res = await request(createApp()).get("/api/projects/p1/workspaces");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("POST /projects/:id/workspaces", () => {
    it("creates a workspace", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.createWorkspace.mockResolvedValue({
        id: "w2", name: "staging", cwd: "/tmp", isPrimary: false,
      });
      const res = await request(createApp())
        .post("/api/projects/p1/workspaces")
        .send({ name: "staging", cwd: "/tmp" });
      expect(res.status).toBe(201);
    });
  });

  describe("DELETE /projects/:id/workspaces/:workspaceId", () => {
    it("deletes a workspace", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.removeWorkspace.mockResolvedValue({ id: "w1", name: "main" });
      const res = await request(createApp()).delete("/api/projects/p1/workspaces/w1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent workspace", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.removeWorkspace.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/projects/p1/workspaces/missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when project not found for workspace delete", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/projects/missing/workspaces/w1");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /projects/:id/workspaces/:workspaceId", () => {
    it("updates a workspace", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.listWorkspaces.mockResolvedValue([{ id: "w1", name: "main" }]);
      mockProjectService.updateWorkspace.mockResolvedValue({ id: "w1", name: "updated" });
      const res = await request(createApp())
        .patch("/api/projects/p1/workspaces/w1")
        .send({ name: "updated" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("updated");
    });

    it("returns 404 when project not found", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/projects/missing/workspaces/w1")
        .send({ name: "updated" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when workspace not found", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.listWorkspaces.mockResolvedValue([{ id: "w1", name: "main" }]);
      const res = await request(createApp())
        .patch("/api/projects/p1/workspaces/missing")
        .send({ name: "updated" });
      expect(res.status).toBe(404);
    });

    it("returns 422 when updateWorkspace returns null", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.listWorkspaces.mockResolvedValue([{ id: "w1", name: "main" }]);
      mockProjectService.updateWorkspace.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/projects/p1/workspaces/w1")
        .send({ name: "bad" });
      expect(res.status).toBe(422);
    });
  });

  describe("POST /companies/:companyId/projects — with workspace", () => {
    it("creates project with inline workspace", async () => {
      mockProjectService.create.mockResolvedValue({ id: "p3", companyId: "company-1", name: "Gamma" });
      mockProjectService.createWorkspace.mockResolvedValue({
        id: "w3", name: "default", cwd: "/tmp", isPrimary: true,
      });
      mockProjectService.getById.mockResolvedValue({
        id: "p3", companyId: "company-1", name: "Gamma", workspaces: [{ id: "w3" }],
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/projects")
        .send({ name: "Gamma", workspace: { name: "default", cwd: "/tmp" } });
      expect(res.status).toBe(201);
    });

    it("returns 422 when workspace creation fails", async () => {
      mockProjectService.create.mockResolvedValue({ id: "p4", companyId: "company-1", name: "Delta" });
      mockProjectService.createWorkspace.mockResolvedValue(null);
      mockProjectService.remove.mockResolvedValue({ id: "p4" });
      const res = await request(createApp())
        .post("/api/companies/company-1/projects")
        .send({ name: "Delta", workspace: { name: "bad", cwd: "/nope" } });
      expect(res.status).toBe(422);
      expect(mockProjectService.remove).toHaveBeenCalledWith("p4");
    });
  });

  describe("POST /projects/:id/workspaces — not found", () => {
    it("returns 404 when project not found", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/projects/missing/workspaces")
        .send({ name: "ws", cwd: "/tmp" });
      expect(res.status).toBe(404);
    });

    it("returns 422 when workspace creation returns null", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.createWorkspace.mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/projects/p1/workspaces")
        .send({ name: "bad", cwd: "/tmp" });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /projects/:id/workspaces — not found", () => {
    it("returns 404 when project not found for workspace list", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/projects/missing/workspaces");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /projects/:id — update returns null", () => {
    it("returns 404 when update returns null", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.update.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/projects/p1")
        .send({ name: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /projects/:id — remove returns null", () => {
    it("returns 404 when remove returns null", async () => {
      mockProjectService.getById.mockResolvedValue({ id: "p1", companyId: "company-1" });
      mockProjectService.remove.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/projects/p1");
      expect(res.status).toBe(404);
    });
  });

  describe("shortname resolution via param middleware", () => {
    it("resolves shortname to project id via companyId query param", async () => {
      mockProjectService.resolveByReference.mockResolvedValue({
        project: { id: "p1", companyId: "company-1" },
        ambiguous: false,
      });
      mockProjectService.getById.mockResolvedValue({
        id: "p1", companyId: "company-1", name: "Alpha",
      });
      const res = await request(createApp()).get("/api/projects/alpha?companyId=company-1");
      expect(res.status).toBe(200);
      expect(mockProjectService.resolveByReference).toHaveBeenCalledWith("company-1", "alpha");
    });

    it("returns 409 when shortname is ambiguous", async () => {
      mockProjectService.resolveByReference.mockResolvedValue({
        project: null,
        ambiguous: true,
      });
      const res = await request(createApp()).get("/api/projects/dup?companyId=company-1");
      expect(res.status).toBe(409);
    });

    it("resolves via agent companyId when no query param", async () => {
      mockProjectService.resolveByReference.mockResolvedValue({
        project: { id: "p1", companyId: "company-1" },
        ambiguous: false,
      });
      mockProjectService.getById.mockResolvedValue({
        id: "p1", companyId: "company-1", name: "Alpha",
      });
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .get("/api/projects/alpha");
      expect(res.status).toBe(200);
    });
  });
});
