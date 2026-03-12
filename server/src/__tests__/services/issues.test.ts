import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { issueService } from "../../services/issues.js";
import { companies, agents, heartbeatRuns } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("issueService", () => {
  let testDb: TestDb;
  let companyId: string;
  let agentId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({ name: "Issue Co", issuePrefix: `I${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
    const [ag] = await testDb.db
      .insert(agents)
      .values({
        companyId,
        name: "Worker",
        role: "general",
        adapterType: "process",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        status: "idle",
      })
      .returning();
    agentId = ag.id;
  });

  function svc() {
    return issueService(testDb.db);
  }

  /** Create a heartbeat_runs row to satisfy FK constraints */
  async function createRun(forAgentId?: string) {
    const [run] = await testDb.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: forAgentId ?? agentId,
        invocationSource: "test",
        status: "running",
      })
      .returning();
    return run;
  }

  // ── create ────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates an issue with auto-generated identifier", async () => {
      const issue = await svc().create(companyId, {
        title: "First issue",
        status: "todo",
      });
      expect(issue).toBeDefined();
      expect(issue.title).toBe("First issue");
      expect(issue.identifier).toBeDefined();
      expect(issue.issueNumber).toBe(1);
    });

    it("increments issue number", async () => {
      await svc().create(companyId, { title: "One", status: "todo" });
      const second = await svc().create(companyId, { title: "Two", status: "todo" });
      expect(second.issueNumber).toBe(2);
    });
  });

  // ── getById ───────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns issue when found", async () => {
      const issue = await svc().create(companyId, { title: "Find me", status: "todo" });
      const found = await svc().getById(issue.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Find me");
    });

    it("negative: returns null for nonexistent", async () => {
      const found = await svc().getById(randomUUID());
      expect(found).toBeNull();
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns issues for company", async () => {
      await svc().create(companyId, { title: "A", status: "todo" });
      await svc().create(companyId, { title: "B", status: "done" });
      const all = await svc().list(companyId);
      expect(all.length).toBe(2);
    });

    it("filters by status", async () => {
      await svc().create(companyId, { title: "Open", status: "todo" });
      await svc().create(companyId, { title: "Closed", status: "done" });
      const filtered = await svc().list(companyId, { status: "todo" });
      expect(filtered.length).toBe(1);
      expect(filtered[0].title).toBe("Open");
    });

    it("filters by assigneeAgentId", async () => {
      await svc().create(companyId, { title: "Assigned", status: "todo", assigneeAgentId: agentId });
      await svc().create(companyId, { title: "Unassigned", status: "todo" });
      const filtered = await svc().list(companyId, { assigneeAgentId: agentId });
      expect(filtered.length).toBe(1);
      expect(filtered[0].title).toBe("Assigned");
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates issue fields", async () => {
      const issue = await svc().create(companyId, { title: "Original", status: "todo" });
      const updated = await svc().update(issue.id, { title: "Updated" });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("Updated");
    });
  });

  // ── status transitions ────────────────────────────────────────────────

  describe("status transitions", () => {
    it("transitions open → in_progress → done", async () => {
      const issue = await svc().create(companyId, {
        title: "Flow",
        status: "todo",
        assigneeAgentId: agentId,
      });

      const inProgress = await svc().update(issue.id, { status: "in_progress" });
      expect(inProgress!.status).toBe("in_progress");
      expect(inProgress!.startedAt).toBeDefined();

      const done = await svc().update(issue.id, { status: "done" });
      expect(done!.status).toBe("done");
      expect(done!.completedAt).toBeDefined();
    });
  });

  // ── checkout / checkin semantics ──────────────────────────────────────

  describe("checkout", () => {
    it("checkout sets assignee and run", async () => {
      const issue = await svc().create(companyId, {
        title: "Checkout test",
        status: "todo",
      });
      const run = await createRun();
      const checkedOut = await svc().checkout(issue.id, agentId, ["todo", "in_progress"], run.id);
      expect(checkedOut).toBeDefined();
      expect(checkedOut!.assigneeAgentId).toBe(agentId);
      expect(checkedOut!.status).toBe("in_progress");
      expect(checkedOut!.checkoutRunId).toBe(run.id);
    });

    it("CRITICAL: double-checkout on different run returns 409", async () => {
      const issue = await svc().create(companyId, {
        title: "Conflict test",
        status: "todo",
      });
      const run1 = await createRun();

      // Create a second agent for the conflict
      const [agent2] = await testDb.db
        .insert(agents)
        .values({
          companyId,
          name: "Other Agent",
          role: "general",
          adapterType: "process",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        })
        .returning();
      const run2 = await createRun(agent2.id);

      await svc().checkout(issue.id, agentId, ["todo", "in_progress"], run1.id);

      await expect(
        svc().checkout(issue.id, agent2.id, ["todo", "in_progress"], run2.id),
      ).rejects.toThrow();
    });

    it("same agent same run re-checkout is idempotent", async () => {
      const issue = await svc().create(companyId, {
        title: "Idempotent test",
        status: "todo",
      });
      const run = await createRun();
      await svc().checkout(issue.id, agentId, ["todo", "in_progress"], run.id);
      const again = await svc().checkout(issue.id, agentId, ["todo", "in_progress"], run.id);
      expect(again).toBeDefined();
      expect(again!.assigneeAgentId).toBe(agentId);
    });
  });

  // ── release ───────────────────────────────────────────────────────────

  describe("release", () => {
    it("releases issue back to todo", async () => {
      const issue = await svc().create(companyId, {
        title: "Release test",
        status: "todo",
      });
      const run = await createRun();
      await svc().checkout(issue.id, agentId, ["todo"], run.id);
      const released = await svc().release(issue.id, agentId, run.id);
      expect(released).not.toBeNull();
      expect(released!.status).toBe("todo");
      expect(released!.assigneeAgentId).toBeNull();
    });
  });

  // ── assignment ────────────────────────────────────────────────────────

  describe("assignment", () => {
    it("assigns to agent via update", async () => {
      const issue = await svc().create(companyId, { title: "Assign me", status: "todo" });
      const updated = await svc().update(issue.id, { assigneeAgentId: agentId });
      expect(updated!.assigneeAgentId).toBe(agentId);
    });
  });
});
