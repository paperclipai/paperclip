import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import { eq, and, sql } from "drizzle-orm";
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
  const { connectionString, cleanup } = await startEmbeddedPostgresTestDatabase("force-reassign-concurrency-");
  cleanupDb = cleanup;
  return createDb(connectionString);
}

describeEmbeddedPostgres("force-reassign concurrency", () => {
  it("concurrent identical forceReassign calls are all idempotent (no duplicate audit/idempotency rows)", async () => {
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
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    const key = randomUUID();

    const promises = Array.from({ length: 10 }, () =>
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: terminatedId,
        toAssigneeId: targetId,
        reason: "Concurrent reassign.",
        idempotencyKey: key,
        actorAgentId: actorId,
        actorUserId: null,
    }),
    );

    const results = await Promise.all(promises);

    const nonIdempotentCount = results.filter((r) => !r.wasIdempotent).length;
    expect(nonIdempotentCount).toBe(1);

    const auditRows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId));
    expect(auditRows.length).toBe(1);

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

    const updated = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(updated.assigneeAgentId).toBe(targetId);
  });

  it("concurrent forceReassign with different keys fails for all-but-one", async () => {
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
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);

    const promises = Array.from({ length: 5 }, () =>
      svc.forceReassign({
        issueId,
        companyId,
        fromAssigneeId: terminatedId,
        toAssigneeId: targetId,
        reason: "Race reassign.",
        idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
      }).catch((err) => err),
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => !(r instanceof Error));
    expect(successes.length).toBe(1);

    const failures = results.filter((r) => r instanceof Error);
    expect(failures.length).toBe(4);
    for (const err of failures) {
      const msg = (err as Error).message;
      expect(msg === "expected_from_mismatch" || msg === "issue_not_orphaned").toBe(true);
    }
  });

  it("verifyAuditChain detects a tampered audit record", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const secondTargetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: secondTargetId, companyId, name: "Target2", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    // Make target terminated so the issue is orphaned again for the second reassign.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, targetId));

    await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: targetId,
      toAssigneeId: secondTargetId,
      reason: "Second.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    const beforeTamper = await svc.verifyAuditChain(companyId);
    expect(beforeTamper.valid).toBe(true);
    expect(beforeTamper.rowCount).toBe(2);

    await db.execute(
      sql`update ${securityAuditLog}
          set hash = 'tampered'
          where tenant_id = ${companyId}
          and id = (
            select id from ${securityAuditLog}
            where tenant_id = ${companyId}
            order by seq desc
            limit 1
          )`,
    );

    const afterTamper = await svc.verifyAuditChain(companyId);
    expect(afterTamper.valid).toBe(false);
    expect(afterTamper.rowCount).toBe(2);
  });

  it("verifyAuditChain detects a broken prevHash linkage", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const secondTargetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: secondTargetId, companyId, name: "Target2", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    // Make target terminated so the issue is orphaned again for the second reassign.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, targetId));

    await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: targetId,
      toAssigneeId: secondTargetId,
      reason: "Second.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId))
      .orderBy(sql`${securityAuditLog.seq} asc`);

    expect(rows.length).toBe(2);
    await db
      .update(securityAuditLog)
      .set({ prevHash: null })
      .where(eq(securityAuditLog.id, rows[1]!.id));

    const result = await svc.verifyAuditChain(companyId);
    expect(result.valid).toBe(false);
    expect(result.rowCount).toBe(2);
  });

  it("audit chain hashes are order-dependent: swapping rows breaks validation", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const secondTargetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: null },
      { id: secondTargetId, companyId, name: "Target2", role: "general", status: "active", reportsTo: null },
      { id: actorId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issue1 = randomUUID();
    const issue2 = randomUUID();
    await db.insert(issues).values([
      { id: issue1, companyId, title: "Issue 1", assigneeAgentId: terminatedId, status: "todo" },
      { id: issue2, companyId, title: "Issue 2", assigneeAgentId: terminatedId, status: "todo" },
    ]);

    const svc = forceReassignService(db);
    await svc.forceReassign({
      issueId: issue1,
      companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    // Make target terminated so the issue is orphaned again for the second reassign.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, targetId));

    await svc.forceReassign({
      issueId: issue2,
      companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: secondTargetId,
      reason: "Second.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    const beforeSwap = await svc.verifyAuditChain(companyId);
    expect(beforeSwap.valid).toBe(true);

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId))
      .orderBy(sql`${securityAuditLog.seq} asc`);
    expect(rows.length).toBe(2);

    const firstSeq = rows[0]!.seq;
    const secondSeq = rows[1]!.seq;

    // Use a temporary seq to avoid the unique (tenant_id, seq) constraint.
    await db
      .update(securityAuditLog)
      .set({ seq: -1 })
      .where(eq(securityAuditLog.id, rows[0]!.id));
    await db
      .update(securityAuditLog)
      .set({ seq: firstSeq })
      .where(eq(securityAuditLog.id, rows[1]!.id));
    await db
      .update(securityAuditLog)
      .set({ seq: secondSeq })
      .where(eq(securityAuditLog.id, rows[0]!.id));

    const afterSwap = await svc.verifyAuditChain(companyId);
    expect(afterSwap.valid).toBe(false);
  });

  it("audit chain hashing is deterministic for nested JSON — varying key orders produce the same hash", async () => {
    const db = await makeDb();

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TestCo" });

    const rootId = randomUUID();
    const midId = randomUUID();
    const terminatedId = randomUUID();
    const targetId = randomUUID();
    const actorId = randomUUID();
    await db.insert(agents).values([
      { id: rootId, companyId, name: "CEO", role: "ceo", status: "active", reportsTo: null },
      { id: midId, companyId, name: "Mid", role: "general", status: "active", reportsTo: rootId },
      { id: terminatedId, companyId, name: "Dead", role: "general", status: "terminated", reportsTo: null },
      { id: targetId, companyId, name: "Target", role: "general", status: "active", reportsTo: rootId },
      { id: actorId, companyId, name: "Board", role: "ceo", status: "active", reportsTo: null },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
        companyId,
      companyId,
      title: "Nested JSON Test",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "Override with deep chain snapshot.",
      idempotencyKey: randomUUID(),
        actorAgentId: actorId,
        actorUserId: null,
    });

    // Chain validation should pass: the fromChainSnapshot has nested objects
    // (agent rows with id, status, role, etc.) and canonicalJson must
    // deep-sort keys so the hash is deterministic.
    const auditResult = await svc.verifyAuditChain(companyId);
    expect(auditResult.valid).toBe(true);
    expect(auditResult.rowCount).toBe(1);

    // Read back the audit row — orphanEvidence is also a nested object
    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.fromChainSnapshot).toBeTruthy();
    expect(rows[0]!.orphanEvidence).toBeTruthy();
  });

  it("idempotency table prevents re-execution even when the original issue is deleted", async () => {
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
      title: "Orphaned Issue",
      assigneeAgentId: terminatedId,
      status: "todo",
    });

    const svc = forceReassignService(db);
    const key = randomUUID();

    const first = await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "First.",
      idempotencyKey: key,
      actorAgentId: actorId,
      actorUserId: null,
    });
    expect(first.wasIdempotent).toBe(false);

    // Delete dependent records first to satisfy FK constraints, but keep the
    // idempotency row so the second call hits the ON CONFLICT path.
    await db.update(forceReassignIdempotency)
      .set({ auditId: null, issueId: null })
      .where(
        and(
          eq(forceReassignIdempotency.companyId, companyId),
          eq(forceReassignIdempotency.idempotencyKey, key),
        ),
      );
    await db.update(securityAuditLog)
      .set({ issueId: null })
      .where(eq(securityAuditLog.issueId, issueId));
    await db.delete(securityAuditLog).where(eq(securityAuditLog.tenantId, companyId));
    await db.delete(issues).where(eq(issues.id, issueId));

    const second = await svc.forceReassign({
      issueId,
        companyId,
      fromAssigneeId: terminatedId,
      toAssigneeId: targetId,
      reason: "Second.",
      idempotencyKey: key,
      actorAgentId: actorId,
      actorUserId: null,
    });
    expect(second.wasIdempotent).toBe(true);

    // The second call must not have created any new side effects.
    const auditRowsAfter = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, companyId));
    expect(auditRowsAfter.length).toBe(0);
  });
});
