import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes } from "../../routes/secrets.js";
import { errorHandler } from "../../middleware/index.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  secretService: () => mockSecretService,
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
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secretRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /companies/:companyId/secret-providers", () => {
    it("returns providers list", async () => {
      mockSecretService.listProviders.mockReturnValue(["local_encrypted", "vault"]);
      const res = await request(createApp()).get("/api/companies/company-1/secret-providers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(["local_encrypted", "vault"]);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/secret-providers");
      expect(res.status).toBe(403);
    });

    it("returns 403 for non-board user", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .get("/api/companies/company-1/secret-providers");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /companies/:companyId/secrets", () => {
    it("lists secrets", async () => {
      mockSecretService.list.mockResolvedValue([{ id: "s1", name: "API_KEY" }]);
      const res = await request(createApp()).get("/api/companies/company-1/secrets");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("POST /companies/:companyId/secrets", () => {
    it("creates a secret", async () => {
      mockSecretService.create.mockResolvedValue({
        id: "s1", name: "API_KEY", provider: "local_encrypted", companyId: "company-1",
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/secrets")
        .send({ name: "API_KEY", value: "secret-value" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("API_KEY");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "secret.created" }),
      );
    });
  });

  describe("POST /secrets/:id/rotate", () => {
    it("rotates a secret", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      mockSecretService.rotate.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1", latestVersion: 2,
      });
      const res = await request(createApp())
        .post("/api/secrets/s1/rotate")
        .send({ value: "new-value" });
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "secret.rotated" }),
      );
    });

    it("returns 404 for nonexistent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/secrets/missing/rotate")
        .send({ value: "new-value" });
      expect(res.status).toBe(404);
    });

    it("returns 403 for wrong company", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "other-company",
      });
      const res = await request(createApp())
        .post("/api/secrets/s1/rotate")
        .send({ value: "new-value" });
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /secrets/:id", () => {
    it("updates a secret", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      mockSecretService.update.mockResolvedValue({
        id: "s1", name: "RENAMED_KEY", companyId: "company-1",
      });
      const res = await request(createApp())
        .patch("/api/secrets/s1")
        .send({ name: "RENAMED_KEY" });
      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "secret.updated" }),
      );
    });

    it("returns 404 for nonexistent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/secrets/missing")
        .send({ name: "RENAMED" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when update returns null", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      mockSecretService.update.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/secrets/s1")
        .send({ name: "RENAMED" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /secrets/:id", () => {
    it("deletes a secret", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      mockSecretService.remove.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      const res = await request(createApp()).delete("/api/secrets/s1");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "secret.deleted" }),
      );
    });

    it("returns 404 for nonexistent secret", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/secrets/missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when remove returns null", async () => {
      mockSecretService.getById.mockResolvedValue({
        id: "s1", name: "API_KEY", companyId: "company-1",
      });
      mockSecretService.remove.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/secrets/s1");
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-board user", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .delete("/api/secrets/s1");
      expect(res.status).toBe(403);
    });
  });
});
