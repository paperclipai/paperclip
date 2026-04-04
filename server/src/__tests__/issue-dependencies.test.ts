import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueDependencies,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueDependencyService } from "../services/issue-dependencies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue dependency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueDependencyService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueDependencyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  async function createIssue(opts: { title: string; status?: string; assigneeAgentId?: string | null }) {
    const [row] = await db.insert(issues).values({
      companyId,
      title: opts.title,
      status: opts.status ?? "todo",
      assigneeAgentId: opts.assigneeAgentId ?? null,
    }).returning();
    return row;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-deps-");
    db = createDb(tempDb.connectionString);
    svc = issueDependencyService(db);

    // Seed a company and agent
    const [company] = await db.insert(companies).values({
      name: "Test Co",
      status: "active",
    }).returning();
    companyId = company.id;

    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Test Agent",
      adapterType: "claude_local",
      adapterConfig: {},
    }).returning();
    agentId = agent.id;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDependencies);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("adds a dependency between two issues", async () => {
    const issueA = await createIssue({ title: "Blocked task" });
    const issueB = await createIssue({ title: "Blocker task" });

    const dep = await svc.addDependency(issueA.id, issueB.id, { agentId });
    expect(dep).toBeTruthy();
    expect(dep.issueId).toBe(issueA.id);
    expect(dep.blockerIssueId).toBe(issueB.id);
    expect(dep.companyId).toBe(companyId);
  });

  it("rejects self-dependency", async () => {
    const issueA = await createIssue({ title: "Self-ref task" });
    await expect(svc.addDependency(issueA.id, issueA.id, { agentId })).rejects.toThrow(
      "An issue cannot depend on itself",
    );
  });

  it("rejects duplicate dependency", async () => {
    const issueA = await createIssue({ title: "Task A" });
    const issueB = await createIssue({ title: "Task B" });

    await svc.addDependency(issueA.id, issueB.id, { agentId });
    await expect(svc.addDependency(issueA.id, issueB.id, { agentId })).rejects.toThrow(
      "This dependency already exists",
    );
  });

  it("rejects cross-company dependency", async () => {
    const [otherCompany] = await db.insert(companies).values({
      name: "Other Co",
      status: "active",
    }).returning();

    const issueA = await createIssue({ title: "My task" });
    const [issueB] = await db.insert(issues).values({
      companyId: otherCompany.id,
      title: "Other task",
      status: "todo",
    }).returning();

    await expect(svc.addDependency(issueA.id, issueB.id, { agentId })).rejects.toThrow(
      "Dependencies must be within the same company",
    );
  });

  it("lists blockers for an issue", async () => {
    const issueA = await createIssue({ title: "Blocked task" });
    const issueB = await createIssue({ title: "Blocker 1" });
    const issueC = await createIssue({ title: "Blocker 2" });

    await svc.addDependency(issueA.id, issueB.id, { agentId });
    await svc.addDependency(issueA.id, issueC.id, { agentId });

    const blockers = await svc.listBlockers(issueA.id);
    expect(blockers).toHaveLength(2);
    expect(blockers.map((b) => b.blockerIssueId).sort()).toEqual(
      [issueB.id, issueC.id].sort(),
    );
    // Enriched fields
    expect(blockers[0].blockerTitle).toBeTruthy();
    expect(blockers[0].blockerStatus).toBe("todo");
  });

  it("lists dependents of a blocker issue", async () => {
    const blocker = await createIssue({ title: "Blocker" });
    const depA = await createIssue({ title: "Dependent A" });
    const depB = await createIssue({ title: "Dependent B" });

    await svc.addDependency(depA.id, blocker.id, { agentId });
    await svc.addDependency(depB.id, blocker.id, { agentId });

    const dependents = await svc.listDependents(blocker.id);
    expect(dependents).toHaveLength(2);
    expect(dependents.map((d) => d.issueId).sort()).toEqual(
      [depA.id, depB.id].sort(),
    );
  });

  it("removes a dependency", async () => {
    const issueA = await createIssue({ title: "Task A" });
    const issueB = await createIssue({ title: "Task B" });

    await svc.addDependency(issueA.id, issueB.id, { agentId });

    const removed = await svc.removeDependency(issueA.id, issueB.id);
    expect(removed).toBeTruthy();

    const blockers = await svc.listBlockers(issueA.id);
    expect(blockers).toHaveLength(0);
  });

  it("returns null when removing non-existent dependency", async () => {
    const removed = await svc.removeDependency(randomUUID(), randomUUID());
    expect(removed).toBeNull();
  });

  describe("findDependentsReadyToWake", () => {
    it("returns dependents when all blockers are resolved", async () => {
      const blocker1 = await createIssue({ title: "Blocker 1", status: "done" });
      const blocker2 = await createIssue({ title: "Blocker 2", status: "cancelled" });
      const dependent = await createIssue({ title: "Dependent", assigneeAgentId: agentId });

      await svc.addDependency(dependent.id, blocker1.id, { agentId });
      await svc.addDependency(dependent.id, blocker2.id, { agentId });

      // When blocker1 resolves, both are resolved => dependent should wake
      const ready = await svc.findDependentsReadyToWake(blocker1.id);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(dependent.id);
    });

    it("does not return dependents with unresolved blockers", async () => {
      const blocker1 = await createIssue({ title: "Blocker 1", status: "done" });
      const blocker2 = await createIssue({ title: "Blocker 2", status: "in_progress" });
      const dependent = await createIssue({ title: "Dependent", assigneeAgentId: agentId });

      await svc.addDependency(dependent.id, blocker1.id, { agentId });
      await svc.addDependency(dependent.id, blocker2.id, { agentId });

      // blocker2 is still in_progress => dependent should NOT wake
      const ready = await svc.findDependentsReadyToWake(blocker1.id);
      expect(ready).toHaveLength(0);
    });

    it("does not return terminal dependents", async () => {
      const blocker = await createIssue({ title: "Blocker", status: "done" });
      const dependent = await createIssue({ title: "Done task", status: "done", assigneeAgentId: agentId });

      await svc.addDependency(dependent.id, blocker.id, { agentId });

      const ready = await svc.findDependentsReadyToWake(blocker.id);
      expect(ready).toHaveLength(0);
    });

    it("does not return dependents without an assignee", async () => {
      const blocker = await createIssue({ title: "Blocker", status: "done" });
      const dependent = await createIssue({ title: "Unassigned task", assigneeAgentId: null });

      await svc.addDependency(dependent.id, blocker.id, { agentId });

      const ready = await svc.findDependentsReadyToWake(blocker.id);
      expect(ready).toHaveLength(0);
    });

    it("returns empty array when no dependents exist", async () => {
      const ready = await svc.findDependentsReadyToWake(randomUUID());
      expect(ready).toHaveLength(0);
    });
  });

  describe("autoUnblockDependents", () => {
    it("transitions blocked dependents to todo", async () => {
      const blocker = await createIssue({ title: "Blocker", status: "done" });
      const dependent = await createIssue({ title: "Blocked dep", status: "blocked", assigneeAgentId: agentId });

      await svc.addDependency(dependent.id, blocker.id, { agentId });

      const unblocked = await svc.autoUnblockDependents([dependent.id]);
      expect(unblocked).toHaveLength(1);
      expect(unblocked[0].id).toBe(dependent.id);

      // Verify status in DB
      const [updated] = await db.select().from(issues).where(eq(issues.id, dependent.id));
      expect(updated.status).toBe("todo");
    });

    it("does not change non-blocked issues", async () => {
      const inProgressIssue = await createIssue({ title: "In progress", status: "in_progress", assigneeAgentId: agentId });

      const unblocked = await svc.autoUnblockDependents([inProgressIssue.id]);
      expect(unblocked).toHaveLength(0);

      const [unchanged] = await db.select().from(issues).where(eq(issues.id, inProgressIssue.id));
      expect(unchanged.status).toBe("in_progress");
    });

    it("handles empty input", async () => {
      const unblocked = await svc.autoUnblockDependents([]);
      expect(unblocked).toHaveLength(0);
    });
  });
});
