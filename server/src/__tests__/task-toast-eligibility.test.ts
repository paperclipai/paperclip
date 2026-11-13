import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { taskToastEligible } from "../realtime/task-toast-eligibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("personal task toast eligibility (persisted data)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-task-toasts-");
    db = createDb(temp.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Toast test", issuePrefix: "TST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared agent", role: "engineer", adapterType: "process" });
  }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function task(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Task", ...overrides });
    return id;
  }
  function event(issueId: string): LiveEvent {
    return { id: 1, companyId, type: "activity.logged", createdAt: new Date().toISOString(),
      payload: { entityType: "issue", entityId: issueId, action: "issue.comment_added", actorType: "agent", actorId: agentId } };
  }
  async function onlyAlice(id: string) {
    expect(await taskToastEligible(db, event(id), "alice")).toBe(true);
    expect(await taskToastEligible(db, event(id), "bob")).toBe(false);
  }

  it("qualifies creators and current human assignees independently", async () => {
    await onlyAlice(await task({ createdByUserId: "alice" }));
    await onlyAlice(await task({ assigneeUserId: "alice" }));
    await onlyAlice(await task({ description: "Please ask [Alice](user://alice)." }));
  });
  it("qualifies a commenter without relying on browser caches", async () => {
    const id = await task();
    await db.insert(issueComments).values({ companyId, issueId: id, authorUserId: "alice", body: "Following this." });
    await onlyAlice(id);
  });
  it("keeps automatic attribution and imported comments quiet until direct participation", async () => {
    for (const originKind of ["chat_channel", "routine_execution"]) {
      const id = await task({ originKind, createdByUserId: "alice", responsibleUserId: "alice" });
      await db.insert(issueComments).values({ companyId, issueId: id, authorUserId: "alice", body: "Imported reply",
        metadata: { version: 1, sourceChannel: "github", sections: [] } });
      await db.insert(activityLog).values({ companyId, entityType: "issue", entityId: id, actorType: "user", actorId: "alice",
        action: "issue.inbox_touched", details: { source: "manual_routine_run" } });
      expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
      await db.insert(issueComments).values({ companyId, issueId: id, authorUserId: "alice", body: "Direct board reply" });
      await onlyAlice(id);
    }
  });
  it("qualifies the first mention and subsequent events, excluding deleted mentions and plain names", async () => {
    const id = await task({ description: "alice user://alice" });
    expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId,
      body: "[Alice](user://alice) please review" }).returning();
    await onlyAlice(id);
    await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId, body: "A later update" });
    await onlyAlice(id);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
    expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
  });
  it("counts deliberate edits but not reads, rejected requests, or automatic cleanup", async () => {
    const id = await task();
    for (const action of ["issue.read_marked", "issue.resource_access_denied", "issue.recovery_action_resolved"]) {
      await db.insert(activityLog).values({ companyId, entityType: "issue", entityId: id, actorType: "user", actorId: "alice",
        action, details: { source: "source_revalidation", trigger: "read_projection" } });
    }
    expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
    await db.insert(activityLog).values({ companyId, entityType: "issue", entityId: id, actorType: "user", actorId: "alice", action: "issue.updated" });
    await onlyAlice(id);
  });
  it("finds an exact historical mention without loading unrelated mention history", async () => {
    const id = await task();
    await db.insert(issueComments).values(Array.from({ length: 500 }, (_, index) => ({
      companyId, issueId: id, authorAgentId: agentId,
      body: `[Another viewer](user://someone-${index}) alice user://alice [Similar](user://alice-extra)`,
    })));
    expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
    await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId,
      body: "[Alice](user://alice?source=review#note)" });
    await onlyAlice(id);
  });
  it("escapes regex syntax in viewer IDs and preserves parsed href forms", async () => {
    const id = await task();
    await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId,
      body: "[Different user](user://aliceXX)" });
    expect(await taskToastEligible(db, event(id), "alice.+")).toBe(false);
    await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId,
      body: "[Alice](user:///alice.+) [Bob](user://name@bob)" });
    expect(await taskToastEligible(db, event(id), "alice.+")).toBe(true);
    expect(await taskToastEligible(db, event(id), "bob")).toBe(true);
  });
  it("does not inherit involvement from responsibility, a shared agent, or a parent", async () => {
    const parentId = await task({ createdByUserId: "alice" });
    const id = await task({ parentId, createdByAgentId: agentId, assigneeAgentId: agentId, responsibleUserId: "alice" });
    await db.insert(issueComments).values({ companyId, issueId: id, authorAgentId: agentId, body: "Agent update" });
    expect(await taskToastEligible(db, event(id), "alice")).toBe(false);
  });
  it("uses the persisted run task, never an event task hint or responsible user", async () => {
    const mine = await task({ createdByUserId: "alice" });
    const other = await task({ createdByUserId: "bob" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other, scopeKind: "issue", responsibleUserId: "alice", status: "failed" }).returning();
    const e: LiveEvent = { ...event(mine), type: "heartbeat.run.status", payload: { runId: run.id, issueId: mine, status: "failed" } };
    expect(await taskToastEligible(db, e, "alice")).toBe(false);
    expect(await taskToastEligible(db, e, "bob")).toBe(true);
    await db.update(heartbeatRuns).set({ issueId: null, scopeKind: "company" }).where(eq(heartbeatRuns.id, run.id));
    expect(await taskToastEligible(db, e, "bob")).toBe(false);
  });
  it("fails closed for missing identity, company mismatch, and generic agent errors; supports local-board", async () => {
    const id = await task({ createdByUserId: "local-board" });
    expect(await taskToastEligible(db, event(id), "local-board")).toBe(true);
    expect(await taskToastEligible(db, event(id), null)).toBe(false);
    expect(await taskToastEligible(db, { ...event(id), companyId: randomUUID() }, "local-board")).toBe(false);
    expect(await taskToastEligible(db, { ...event(id), type: "agent.status" }, "local-board")).toBe(false);
  });
});
