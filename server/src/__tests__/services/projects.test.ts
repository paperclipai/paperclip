import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { projectService } from "../../services/projects.js";
import { companies } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("projectService", () => {
  let testDb: TestDb;
  let companyId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({ name: "Project Co", issuePrefix: `P${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return projectService(testDb.db);
  }

  // ── create ────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a project with urlKey", async () => {
      const project = await svc().create(companyId, { name: "Backend" });
      expect(project).toBeDefined();
      expect(project.name).toBe("Backend");
      expect(project.companyId).toBe(companyId);
      expect(project.urlKey).toBeDefined();
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists projects for company", async () => {
      await svc().create(companyId, { name: "Alpha" });
      await svc().create(companyId, { name: "Beta" });
      const all = await svc().list(companyId);
      expect(all.length).toBe(2);
    });
  });

  // ── getById ───────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns project when found", async () => {
      const project = await svc().create(companyId, { name: "Find" });
      const found = await svc().getById(project.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Find");
    });

    it("negative: returns null for nonexistent", async () => {
      const found = await svc().getById(randomUUID());
      expect(found).toBeNull();
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates project fields", async () => {
      const project = await svc().create(companyId, { name: "Old" });
      const updated = await svc().update(project.id, { name: "New" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New");
    });

    it("negative: returns null for nonexistent", async () => {
      const updated = await svc().update(randomUUID(), { name: "X" });
      expect(updated).toBeNull();
    });
  });

  // ── remove ────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("deletes project", async () => {
      const project = await svc().create(companyId, { name: "Delete me" });
      const removed = await svc().remove(project.id);
      expect(removed).not.toBeNull();
      const after = await svc().getById(project.id);
      expect(after).toBeNull();
    });

    it("negative: returns null for nonexistent", async () => {
      const removed = await svc().remove(randomUUID());
      expect(removed).toBeNull();
    });
  });

  // ── shortname resolution ──────────────────────────────────────────────

  describe("shortname resolution", () => {
    it("deduplicates project names", async () => {
      const p1 = await svc().create(companyId, { name: "API" });
      const p2 = await svc().create(companyId, { name: "API" });
      expect(p1.name).toBe("API");
      expect(p2.name).toBe("API 2");
    });

    it("resolves project by reference", async () => {
      const project = await svc().create(companyId, { name: "Backend" });
      const byId = await svc().resolveByReference(companyId, project.id);
      expect(byId.project).not.toBeNull();
      expect(byId.project!.id).toBe(project.id);
    });

    it("negative: returns null for empty reference", async () => {
      const result = await svc().resolveByReference(companyId, "");
      expect(result.project).toBeNull();
    });
  });
});
