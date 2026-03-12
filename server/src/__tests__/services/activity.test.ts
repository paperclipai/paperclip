import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { activityService } from "../../services/activity.js";
import { logActivity } from "../../services/activity-log.js";
import { agents, companies, activityLog } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("activityService & logActivity", () => {
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
      .values({ name: "Activity Co", issuePrefix: `X${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  // ── logActivity ───────────────────────────────────────────────────────

  describe("logActivity", () => {
    it("creates a log entry", async () => {
      await logActivity(testDb.db, {
        companyId,
        actorType: "system",
        actorId: "test",
        action: "test.action",
        entityType: "company",
        entityId: companyId,
        details: { key: "value" },
      });

      const rows = await testDb.db.select().from(activityLog);
      expect(rows.length).toBe(1);
      expect(rows[0].action).toBe("test.action");
    });
  });

  // ── activityService.list ──────────────────────────────────────────────

  describe("list", () => {
    it("lists with company filter", async () => {
      const svc = activityService(testDb.db);
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "issue.created",
        entityType: "issue",
        entityId: randomUUID(),
      });
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "agent.created",
        entityType: "agent",
        entityId: randomUUID(),
      });

      const all = await svc.list({ companyId });
      expect(all.length).toBe(2);
    });

    it("filters by entityType", async () => {
      const svc = activityService(testDb.db);
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "agent.created",
        entityType: "agent",
        entityId: randomUUID(),
      });
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
      });

      const filtered = await svc.list({ companyId, entityType: "agent" });
      expect(filtered.length).toBe(1);
      expect(filtered[0].entityType).toBe("agent");
    });
  });

  // ── activityService.create ────────────────────────────────────────────

  describe("create", () => {
    it("creates an entry via service", async () => {
      const svc = activityService(testDb.db);
      const entry = await svc.create({
        companyId,
        actorType: "system",
        actorId: "test",
        action: "svc.test",
        entityType: "test",
        entityId: randomUUID(),
      });
      expect(entry).toBeDefined();
      expect(entry.action).toBe("svc.test");
    });
  });

  // ── list filters ─────────────────────────────────────────────────────

  describe("list with agentId and entityId filters", () => {
    it("filters by agentId", async () => {
      const svc = activityService(testDb.db);
      const [ag] = await testDb.db
        .insert(agents)
        .values({ companyId, name: "Logger", role: "general", adapterType: "process", budgetMonthlyCents: 0, spentMonthlyCents: 0, status: "idle" })
        .returning();
      const agentId = ag.id;
      await logActivity(testDb.db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "agent.action",
        entityType: "agent",
        entityId: agentId,
      });
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "user.action",
        entityType: "company",
        entityId: companyId,
      });

      const filtered = await svc.list({ companyId, agentId });
      expect(filtered.length).toBe(1);
      expect(filtered[0].action).toBe("agent.action");
    });

    it("filters by entityId", async () => {
      const svc = activityService(testDb.db);
      const entityId = randomUUID();
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "target.action",
        entityType: "agent",
        entityId,
      });
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "other.action",
        entityType: "agent",
        entityId: randomUUID(),
      });

      const filtered = await svc.list({ companyId, entityId });
      expect(filtered.length).toBe(1);
      expect(filtered[0].action).toBe("target.action");
    });
  });

  // ── forIssue ────────────────────────────────────────────────────────

  describe("forIssue", () => {
    it("returns activity for a specific issue", async () => {
      const svc = activityService(testDb.db);
      const issueId = randomUUID();
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
      });
      await logActivity(testDb.db, {
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "other.action",
        entityType: "agent",
        entityId: randomUUID(),
      });

      const result = await svc.forIssue(issueId);
      expect(result.length).toBe(1);
      expect(result[0].entityId).toBe(issueId);
    });

    it("returns empty for nonexistent issue", async () => {
      const svc = activityService(testDb.db);
      const result = await svc.forIssue(randomUUID());
      expect(result.length).toBe(0);
    });
  });

  // ── runsForIssue ────────────────────────────────────────────────────

  describe("runsForIssue", () => {
    it("returns empty when no runs touch the issue", async () => {
      const svc = activityService(testDb.db);
      const result = await svc.runsForIssue(companyId, randomUUID());
      expect(result.length).toBe(0);
    });
  });

  // ── issuesForRun ────────────────────────────────────────────────────

  describe("issuesForRun", () => {
    it("returns empty for nonexistent run", async () => {
      const svc = activityService(testDb.db);
      const result = await svc.issuesForRun(randomUUID());
      expect(result).toEqual([]);
    });
  });

  // ── negative ──────────────────────────────────────────────────────────

  describe("negative", () => {
    it("returns empty list for unknown company", async () => {
      const svc = activityService(testDb.db);
      const list = await svc.list({ companyId: randomUUID() });
      expect(list.length).toBe(0);
    });
  });
});
