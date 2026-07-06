import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  forceReassignIdempotency,
  issues,
  securityAuditLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { forceReassignService } from "../services/force-reassign.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let cleanupDb: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanupDb?.();
  cleanupDb = null;
});

async function makeDb() {
  const { connectionString, cleanup } = await startEmbeddedPostgresTestDatabase("force-reassign-");
  cleanupDb = cleanup;
  return createDb(connectionString);
}

describeEmbeddedPostgres("force-reassign service", () => {
  it("isOrphaned returns false for an issue with a healthy assignee and valid chain", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const assigneeId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: assigneeId, companyId, name: "Worker", role: "general", status: "active", reportsTo: rootId },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Test Issue",
      assigneeAgentId: assigneeId,
    });

    const svc = forceReassignService(db);
    const result = await svc.isOrphaned(companyId, assigneeId);

    expect(result.orphaned).toBe(false);
    expect(result.evidence.matchedCondition).toBe("healthy");
    expect(result.evidence.assigneeExists).toBe(true);
  });

  it("isOrphaned returns true for an issue assigned to a missing/deleted agent", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const svc = forceReassignService(db);
    const result = await svc.isOrphaned(companyId, randomUUID());

    expect(result.orphaned).toBe(true);
    expect(result.evidence.matchedCondition).toBe("assignee_missing_or_deleted");
    expect(result.evidence.assigneeExists).toBe(false);
  });

  it("isOrphaned returns true for an issue assigned to a terminated agent with broken chain", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    await db.insert(agents).values({
      id: terminatedId,
      companyId,
      name: "Terminated",
      role: "general",
      status: "terminated",
      reportsTo: null,
    });

    const svc = forceReassignService(db);
    const result = await svc.isOrphaned(companyId, terminatedId);

    expect(result.orphaned).toBe(true);
    expect(result.evidence.matchedCondition).toBe("assignee_terminated_and_chain_broken");
  });

  it("isOrphaned returns false for terminated agent when a valid chain exists", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const terminatedId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: terminatedId, companyId, name: "Old", role: "general", status: "terminated", reportsTo: rootId },
    ]);

    const svc = forceReassignService(db);
    const result = await svc.isOrphaned(companyId, terminatedId);

    expect(result.orphaned).toBe(false);
    expect(result.evidence.matchedCondition).toBe("assignee_terminated_but_chain_valid");
  });

  it("chainReachesLiveRoot returns false for cyclic reporting chain", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(agents).values([
      { id: agentA, companyId, name: "A", role: "general", status: "active", reportsTo: agentB },
      { id: agentB, companyId, name: "B", role: "general", status: "active", reportsTo: agentA },
    ]);

    const svc = forceReassignService(db);
    const valid = await svc.chainReachesLiveRoot(agentA, companyId);

    expect(valid).toBe(false);
  });

  it("chainReachesLiveRoot returns false when a manager in the chain is terminated", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const midId = randomUUID();
    const leafId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: midId, companyId, name: "Mid", role: "general", status: "terminated", reportsTo: rootId },
      { id: leafId, companyId, name: "Leaf", role: "general", status: "active", reportsTo: midId },
    ]);

    const svc = forceReassignService(db);
    const valid = await svc.chainReachesLiveRoot(leafId, companyId);

    expect(valid).toBe(false);
  });

  it("chainReachesLiveRoot returns true for a valid chain from leaf to root", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const midId = randomUUID();
    const leafId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: midId, companyId, name: "Mid", role: "general", status: "active", reportsTo: rootId },
      { id: leafId, companyId, name: "Leaf", role: "general", status: "active", reportsTo: midId },
    ]);

    const svc = forceReassignService(db);
    const valid = await svc.chainReachesLiveRoot(leafId, companyId);

    expect(valid).toBe(true);
  });

  it("forceReassign reassigns an orphaned issue and writes audit + idempotency records", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    const key = randomUUID();
    const result = await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "Terminated agent, must reassign to restore liveness.",
      idempotencyKey: key,
      actorAgentId: actorId,
      actorUserId: null,
    });

    expect(result.issueId).toBe(issueId);
    expect(result.fromAssigneeId).toBe(terminatedId);
    expect(result.toAssigneeId).toBe(targetId);
    expect(result.wasIdempotent).toBe(false);
    // The audit-row seq + id are threaded back to the caller so the
    // route can include them in the activity.logged event for the
    // force-reassign volume signal hook ([RAM-979](/RAM/issues/RAM-979),
    // [RAM-982](/RAM/issues/RAM-982)). Assert the first reassign on
    // a fresh tenant yields seq=1 + a non-null auditId.
    expect(result.auditSeq).toBe(1);
    expect(result.auditId).not.toBeNull();
    expect(typeof result.auditId).toBe("string");
    expect((result.auditId as string).length).toBeGreaterThan(0);

    const updated = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(updated).not.toBeNull();
    expect(updated!.assigneeAgentId).toBe(targetId);
    expect(updated!.checkoutRunId).toBeNull();
    expect(updated!.assigneeLivenessStatus).toBe("healthy");

    const auditRows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId));

    expect(auditRows.length).toBe(1);
    expect(auditRows[0].eventType).toBe("ISSUE_FORCE_REASSIGN");
    expect(auditRows[0].fromAssigneeId).toBe(terminatedId);
    expect(auditRows[0].toAssigneeId).toBe(targetId);
    expect(auditRows[0].reason).toBe("Terminated agent, must reassign to restore liveness.");
    expect(auditRows[0].prevHash).toBeNull();
    expect(auditRows[0].hash).toBeTruthy();
    expect(auditRows[0].seq).toBe(1);
    expect(auditRows[0].id).toBe(result.auditId);

    const idempotentRows = await db
      .select()
      .from(forceReassignIdempotency)
      .where(
        and(
          eq(forceReassignIdempotency.companyId, companyId),
          eq(forceReassignIdempotency.idempotencyKey, key),
        ),
      );

    expect(idempotentRows.length).toBe(1);
  });

  it("forceReassign returns idempotent result for the same key", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
    });

    const svc = forceReassignService(db);
    const key = randomUUID();

    const first = await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First attempt.",
      idempotencyKey: key,
      actorAgentId: actorId,
      actorUserId: null,
    });
    expect(first.wasIdempotent).toBe(false);
    expect(first.auditSeq).toBe(1);
    expect(first.auditId).not.toBeNull();

    const second = await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "Second attempt.",
      idempotencyKey: key,
      actorAgentId: actorId,
      actorUserId: null,
    });
    expect(second.wasIdempotent).toBe(true);
    // Idempotent replay: no new audit row, so the caller cannot
    // thread a fresh seq/id into a new activity.logged event.
    // The CISO's volume signal hook dedup-by-seq key naturally
    // falls out of this — the idempotent replay never publishes.
    expect(second.auditSeq).toBeNull();
    expect(second.auditId).toBe(first.auditId);
  });

  it("forceReassign throws issue_not_orphaned for a healthy issue", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const healthyId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: healthyId, companyId, name: "Healthy", role: "general", status: "active", reportsTo: rootId },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: rootId },
      { id: actorId, companyId, name: "Board", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Healthy Issue",
      assigneeAgentId: healthyId,
    });

    const svc = forceReassignService(db);

    await expect(
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: healthyId,
        toAssigneeId: targetId,
        reason: "Should not work.",
        idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
      }),
    ).rejects.toThrow("issue_not_orphaned");
  });

  it("forceReassign throws issue_not_orphaned for a terminated assignee with a valid manager chain", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: terminatedId, companyId, name: "Old", role: "general", status: "terminated", reportsTo: rootId },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: rootId },
      { id: actorId, companyId, name: "Board", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Issue with terminated but chain-valid assignee",
      assigneeAgentId: terminatedId,
    });

    const svc = forceReassignService(db);

    // First confirm isOrphaned returns false
    const orphanCheck = await svc.isOrphaned(companyId, terminatedId);
    expect(orphanCheck.orphaned).toBe(false);
    expect(orphanCheck.evidence.matchedCondition).toBe("assignee_terminated_but_chain_valid");

    // forceReassign should reject — the chain is valid, so the issue isn't orphaned
    await expect(
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: terminatedId,
        toAssigneeId: targetId,
        reason: "Should be rejected.",
        idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
      }),
    ).rejects.toThrow("issue_not_orphaned");
  });

  it("forceReassign throws expected_from_mismatch when assignee doesn't match", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const wrongId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: wrongId, companyId, name: "Other", role: "general", status: "active", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
    });

    const svc = forceReassignService(db);

    await expect(
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: wrongId,
        toAssigneeId: targetId,
        reason: "Wrong from.",
        idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
      }),
    ).rejects.toThrow("expected_from_mismatch");
  });

  it("forceReassign throws target_not_invokable when target is terminated", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetTerminatedId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetTerminatedId, companyId, name: "DeadTarget", role: "general", status: "terminated", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
    });

    const svc = forceReassignService(db);

    await expect(
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: terminatedId,
        toAssigneeId: targetTerminatedId,
        reason: "Target is dead too.",
        idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
      }),
    ).rejects.toThrow("target_not_invokable");
  });

  it("verifyAuditChain validates a correct hash chain", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    await db.insert(issues).values([
      { id: issueId1, companyId, title: "Issue 1", assigneeAgentId: terminatedId },
      { id: issueId2, companyId, title: "Issue 2", assigneeAgentId: terminatedId },
    ]);

    const svc = forceReassignService(db);

    await svc.forceReassign({
      issueId: issueId1,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First override.",
      idempotencyKey: randomUUID(),
      actorAgentId: actorId,
      actorUserId: null,
    });

    await svc.forceReassign({
      issueId: issueId2,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "Second override.",
      idempotencyKey: randomUUID(),
      actorAgentId: actorId,
      actorUserId: null,
    });

    const auditResult = await svc.verifyAuditChain(companyId);
    expect(auditResult.valid).toBe(true);
    expect(auditResult.rowCount).toBe(2);
  });

  it("sweepOrphanedIssues flags orphaned issues with liveness status", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    await db.insert(agents).values({
      id: terminatedId,
      companyId,
      name: "Dead",
      role: "general",
      status: "terminated",
      reportsTo: null,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    const flagged = await svc.sweepOrphanedIssues(companyId, 10);

    expect(flagged).toBe(1);

    const updated = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(updated!.assigneeUninvokable).toBe("true");
    expect(updated!.assigneeLivenessStatus).toBe("orphaned");
    expect(updated!.assigneeUninvokableAt).toBeTruthy();
  });
});