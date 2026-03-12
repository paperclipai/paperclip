import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { companyService } from "../../services/companies.js";
import { agents } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("companyService", () => {
  let testDb: TestDb;
  let svc: ReturnType<typeof companyService>;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    svc = companyService(testDb.db);
  });

  // ── create ────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates company with auto-generated issue prefix", async () => {
      const co = await svc.create({ name: "Acme Corp" });
      expect(co).toBeDefined();
      expect(co.name).toBe("Acme Corp");
      expect(co.issuePrefix).toBe("ACM");
    });

    it("handles unique prefix collision by appending suffix", async () => {
      const co1 = await svc.create({ name: "Acme" });
      const co2 = await svc.create({ name: "Acme Intl" });
      expect(co1.issuePrefix).toBe("ACM");
      expect(co2.issuePrefix).toBe("ACMA");
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all companies", async () => {
      await svc.create({ name: "Alpha" });
      await svc.create({ name: "Beta" });
      const all = await svc.list();
      expect(all.length).toBe(2);
    });
  });

  // ── getById ───────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns company when found", async () => {
      const co = await svc.create({ name: "Test" });
      const found = await svc.getById(co.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Test");
    });

    it("negative: returns null when not found", async () => {
      const found = await svc.getById(randomUUID());
      expect(found).toBeNull();
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates fields", async () => {
      const co = await svc.create({ name: "Old Name" });
      const updated = await svc.update(co.id, { name: "New Name" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
    });

    it("negative: returns null for nonexistent", async () => {
      const updated = await svc.update(randomUUID(), { name: "X" });
      expect(updated).toBeNull();
    });
  });

  // ── archive ───────────────────────────────────────────────────────────

  describe("archive", () => {
    it("sets status to archived", async () => {
      const co = await svc.create({ name: "To Archive" });
      const archived = await svc.archive(co.id);
      expect(archived).not.toBeNull();
      expect(archived!.status).toBe("archived");
    });

    it("negative: returns null for nonexistent", async () => {
      const archived = await svc.archive(randomUUID());
      expect(archived).toBeNull();
    });
  });

  // ── remove ────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("cascade deletes all child rows", async () => {
      const co = await svc.create({ name: "To Delete" });
      // Insert an agent as a child row
      await testDb.db.insert(agents).values({
        companyId: co.id,
        name: "TestBot",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      });
      const removed = await svc.remove(co.id);
      expect(removed).not.toBeNull();
      expect(removed!.id).toBe(co.id);

      // Company gone
      const after = await svc.getById(co.id);
      expect(after).toBeNull();
    });

    it("negative: returns null for nonexistent", async () => {
      const removed = await svc.remove(randomUUID());
      expect(removed).toBeNull();
    });
  });

  // ── stats ─────────────────────────────────────────────────────────────

  describe("stats", () => {
    it("aggregates agent/issue counts per company", async () => {
      const co = await svc.create({ name: "Stats Co" });
      await testDb.db.insert(agents).values({
        companyId: co.id,
        name: "Bot1",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      });
      await testDb.db.insert(agents).values({
        companyId: co.id,
        name: "Bot2",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      });

      const stats = await svc.stats();
      expect(stats[co.id]).toBeDefined();
      expect(stats[co.id].agentCount).toBe(2);
    });
  });
});
