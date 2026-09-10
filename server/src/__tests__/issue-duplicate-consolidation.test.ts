import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type ExpectedIssueSnapshot = {
  issueId: string;
  parentId: string | null;
  projectId: string | null;
  title: string;
  description: string | null;
  status: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockedByIssueIds: string[];
  blocksIssueIds: string[];
};

async function expectedSnapshots(
  db: Db,
  companyId: string,
  canonicalIssueId: string,
  duplicateIssueId: string,
): Promise<ExpectedIssueSnapshot[]> {
  const relations = await db
    .select()
    .from(issueRelations)
    .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));
  const affectedIds = new Set([canonicalIssueId, duplicateIssueId]);
  for (const relation of relations) {
    if (relation.issueId === duplicateIssueId) affectedIds.add(relation.relatedIssueId);
  }
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), or(...[...affectedIds].map((id) => eq(issues.id, id)))))
    .orderBy(asc(issues.id));
  return rows.map((row) => ({
    issueId: row.id,
    parentId: row.parentId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    blockedByIssueIds: relations
      .filter((relation) => relation.relatedIssueId === row.id)
      .map((relation) => relation.issueId)
      .sort(),
    blocksIssueIds: relations
      .filter((relation) => relation.issueId === row.id)
      .map((relation) => relation.relatedIssueId)
      .sort(),
  }));
}

describeEmbeddedPostgres("atomic duplicate issue consolidation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-duplicate-consolidation-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const canonicalIssueId = randomUUID();
    const duplicateIssueId = randomUUID();
    const dependentIssueId = randomUUID();
    const otherBlockerId = randomUUID();
    const duplicateBlockerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId}`,
      issuePrefix: `D${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Implementation owner", status: "blocked", priority: "high" },
      {
        id: canonicalIssueId,
        companyId,
        title: "QA review: repo#1",
        description: "PR: https://example.test/repo/pull/1",
        status: "in_review",
        priority: "high",
        assigneeUserId: "qa-owner",
        createdByUserId: "automation",
        executionPolicy: { monitor: { kind: "external_service", maxAttempts: 3 } },
        monitorAttemptCount: 1,
      },
      {
        id: duplicateIssueId,
        companyId,
        parentId,
        title: "QA re-review: repo#1",
        description: "PR: https://example.test/repo/pull/1",
        status: "in_review",
        priority: "high",
        assigneeUserId: "qa-owner",
        createdByUserId: "automation",
        executionPolicy: { monitor: { kind: "external_service", maxAttempts: 5 } },
        monitorAttemptCount: 2,
      },
      { id: dependentIssueId, companyId, title: "Release owner", status: "blocked", priority: "high" },
      { id: otherBlockerId, companyId, title: "Other gate", status: "todo", priority: "high" },
      { id: duplicateBlockerId, companyId, title: "Duplicate gate", status: "todo", priority: "high" },
    ]);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: otherBlockerId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
        createdByUserId: "human-a",
      },
      {
        companyId,
        issueId: duplicateIssueId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
        createdByUserId: "human-b",
      },
      {
        companyId,
        issueId: duplicateBlockerId,
        relatedIssueId: duplicateIssueId,
        type: "blocks",
        createdByUserId: "human-c",
      },
    ]);
    return {
      companyId,
      parentId,
      canonicalIssueId,
      duplicateIssueId,
      dependentIssueId,
      otherBlockerId,
      duplicateBlockerId,
    };
  }

  async function consolidate(
    ids: Awaited<ReturnType<typeof fixture>>,
    idempotencyKey = randomUUID(),
    expected?: ExpectedIssueSnapshot[],
  ) {
    const effectiveExpected = expected ?? await expectedSnapshots(
      db,
      ids.companyId,
      ids.canonicalIssueId,
      ids.duplicateIssueId,
    );
    return issueService(db).consolidateDuplicate(ids.canonicalIssueId, {
      duplicateIssueId: ids.duplicateIssueId,
      idempotencyKey,
      expected: effectiveExpected,
      actor: { userId: "operator", agentId: null, runId: null, apiKeyId: null },
    });
  }

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("exposes the atomic operation through the authenticated issue control plane", async () => {
    const ids = await fixture();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    const response = await request(createApp())
      .post(`/api/issues/${ids.canonicalIssueId}/consolidate-duplicate`)
      .send({ duplicateIssueId: ids.duplicateIssueId, idempotencyKey: randomUUID(), expected })
      .expect(200);

    expect(response.body).toMatchObject({
      canonicalIssueId: ids.canonicalIssueId,
      duplicateIssueId: ids.duplicateIssueId,
      idempotent: false,
    });
    expect(await db.select().from(issues).where(and(
      eq(issues.id, ids.duplicateIssueId),
      eq(issues.status, "cancelled"),
    ))).toHaveLength(1);
  });

  it("moves parent and blocker edges atomically without changing owners, monitors, or provenance", async () => {
    const ids = await fixture();
    const result = await consolidate(ids);

    expect(result.idempotent).toBe(false);
    expect(result.migratedIssueIds.sort()).toEqual(
      [ids.canonicalIssueId, ids.dependentIssueId, ids.duplicateIssueId].sort(),
    );
    const [canonical, duplicate, dependent] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, ids.canonicalIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, ids.duplicateIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, ids.dependentIssueId)).then((rows) => rows[0]),
    ]);
    expect(canonical).toMatchObject({
      parentId: ids.parentId,
      status: "in_review",
      assigneeUserId: "qa-owner",
      createdByUserId: "automation",
      monitorAttemptCount: 1,
    });
    expect(duplicate).toMatchObject({
      parentId: ids.parentId,
      status: "cancelled",
      assigneeUserId: "qa-owner",
      createdByUserId: "automation",
      monitorAttemptCount: 2,
    });
    expect(dependent).toMatchObject({ status: "blocked" });
    const edges = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, ids.companyId));
    expect(edges.map((edge) => [edge.issueId, edge.relatedIssueId]).sort()).toEqual([
      [ids.canonicalIssueId, ids.dependentIssueId],
      [ids.duplicateBlockerId, ids.canonicalIssueId],
      [ids.otherBlockerId, ids.dependentIssueId],
    ].sort());
    expect(edges.find((edge) => edge.issueId === ids.canonicalIssueId)?.createdByUserId).toBe("human-b");
    expect(edges.find((edge) => edge.issueId === ids.duplicateBlockerId)?.createdByUserId).toBe("human-c");
    const audit = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, ids.companyId),
        eq(activityLog.action, "issue.duplicate_consolidated"),
      ));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({
      canonicalIssueId: ids.canonicalIssueId,
      duplicateIssueId: ids.duplicateIssueId,
      actorUserId: "operator",
    });
  });

  it("rejects a blocker added after the client snapshot and leaves the duplicate open", async () => {
    const ids = await fixture();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    const newGateId = randomUUID();
    await db.insert(issues).values({ id: newGateId, companyId: ids.companyId, title: "New gate", status: "todo" });
    await db.insert(issueRelations).values({
      companyId: ids.companyId,
      issueId: newGateId,
      relatedIssueId: ids.dependentIssueId,
      type: "blocks",
    });

    await expect(consolidate(ids, randomUUID(), expected)).rejects.toMatchObject<HttpError>({ status: 409 });
    const duplicate = await db.select().from(issues).where(eq(issues.id, ids.duplicateIssueId)).then((rows) => rows[0]);
    const newGate = await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, newGateId),
      eq(issueRelations.relatedIssueId, ids.dependentIssueId),
    ));
    expect(duplicate?.status).toBe("in_review");
    expect(newGate).toHaveLength(1);
  });

  it("rejects a new dependent relation that arrives before cancellation", async () => {
    const ids = await fixture();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    const newDependentId = randomUUID();
    await db.insert(issues).values({ id: newDependentId, companyId: ids.companyId, title: "New dependent", status: "blocked" });
    await db.insert(issueRelations).values({
      companyId: ids.companyId,
      issueId: ids.duplicateIssueId,
      relatedIssueId: newDependentId,
      type: "blocks",
    });

    await expect(consolidate(ids, randomUUID(), expected)).rejects.toMatchObject<HttpError>({ status: 409 });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, ids.duplicateIssueId),
      eq(issueRelations.relatedIssueId, newDependentId),
    ))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(
      eq(issues.id, ids.duplicateIssueId),
      eq(issues.status, "in_review"),
    ))).toHaveLength(1);
  });

  it("rolls back every edge and parent change when cancellation fails", async () => {
    const ids = await fixture();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    await db.execute(sql`
      create or replace function reject_test_duplicate_cancel() returns trigger as $$
      begin
        if new.status = 'cancelled' then
          raise exception 'test cancellation failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
    `);
    await db.execute(sql`
      create trigger reject_test_duplicate_cancel
      before update on issues
      for each row execute function reject_test_duplicate_cancel();
    `);
    try {
      await expect(consolidate(ids, randomUUID(), expected)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger if exists reject_test_duplicate_cancel on issues`);
      await db.execute(sql`drop function if exists reject_test_duplicate_cancel()`);
    }
    expect(await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId)).toEqual(expected);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, ids.companyId),
      eq(activityLog.action, "issue.duplicate_consolidated"),
    ))).toHaveLength(0);
  });

  it("returns the prior receipt when the same idempotency key is retried", async () => {
    const ids = await fixture();
    const key = randomUUID();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    const first = await consolidate(ids, key, expected);
    const second = await consolidate(ids, key, expected);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.auditActivityId).toBe(first.auditActivityId);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, ids.companyId),
      eq(activityLog.action, "issue.duplicate_consolidated"),
    ))).toHaveLength(1);
  });

  it("rejects conflicting parents and direct dependency cycles", async () => {
    const parentConflict = await fixture();
    const otherParentId = randomUUID();
    await db.insert(issues).values({ id: otherParentId, companyId: parentConflict.companyId, title: "Other parent", status: "todo" });
    await db.update(issues).set({ parentId: otherParentId }).where(eq(issues.id, parentConflict.canonicalIssueId));
    const expectedParentConflict = await expectedSnapshots(
      db,
      parentConflict.companyId,
      parentConflict.canonicalIssueId,
      parentConflict.duplicateIssueId,
    );
    await expect(consolidate(parentConflict, randomUUID(), expectedParentConflict)).rejects.toMatchObject<HttpError>({ status: 409 });

    const cycle = await fixture();
    await db.insert(issueRelations).values({
      companyId: cycle.companyId,
      issueId: cycle.canonicalIssueId,
      relatedIssueId: cycle.duplicateIssueId,
      type: "blocks",
    });
    const expectedCycle = await expectedSnapshots(db, cycle.companyId, cycle.canonicalIssueId, cycle.duplicateIssueId);
    await expect(consolidate(cycle, randomUUID(), expectedCycle)).rejects.toMatchObject<HttpError>({ status: 409 });
  });

  it("rejects a parent cycle introduced by adopting the duplicate parent", async () => {
    const ids = await fixture();
    await db.update(issues).set({ parentId: ids.canonicalIssueId }).where(eq(issues.id, ids.parentId));
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    await expect(consolidate(ids, randomUUID(), expected)).rejects.toMatchObject<HttpError>({ status: 409 });
    expect(await db.select().from(issues).where(and(
      eq(issues.id, ids.duplicateIssueId),
      eq(issues.status, "in_review"),
    ))).toHaveLength(1);
  });

  it("serializes with a real concurrent graph transaction and rejects the stale snapshot", async () => {
    const ids = await fixture();
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    const newGateId = randomUUID();
    await db.insert(issues).values({ id: newGateId, companyId: ids.companyId, title: "Concurrent gate", status: "todo" });
    let releaseWriter!: () => void;
    const writerCanCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerLocked!: () => void;
    const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-graph:' + ids.companyId}, 0))`);
      await tx.insert(issueRelations).values({
        companyId: ids.companyId,
        issueId: newGateId,
        relatedIssueId: ids.dependentIssueId,
        type: "blocks",
      });
      writerLocked();
      await writerCanCommit;
    });
    await writerHasLock;
    const consolidation = consolidate(ids, randomUUID(), expected);
    releaseWriter();
    await writer;
    await expect(consolidation).rejects.toMatchObject<HttpError>({ status: 409 });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, newGateId),
      eq(issueRelations.relatedIssueId, ids.dependentIssueId),
    ))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(
      eq(issues.id, ids.duplicateIssueId),
      eq(issues.status, "in_review"),
    ))).toHaveLength(1);
  });

  it("rejects a pending human approval instead of discarding its decision path", async () => {
    const ids = await fixture();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId: ids.companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    await db.insert(issueApprovals).values({
      companyId: ids.companyId,
      issueId: ids.duplicateIssueId,
      approvalId,
    });
    const expected = await expectedSnapshots(db, ids.companyId, ids.canonicalIssueId, ids.duplicateIssueId);
    await expect(consolidate(ids, randomUUID(), expected)).rejects.toMatchObject<HttpError>({ status: 409 });
    expect(await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approvalId))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(
      eq(issues.id, ids.duplicateIssueId),
      eq(issues.status, "in_review"),
    ))).toHaveLength(1);
  });

  it("preserves a completed human approval on the cancelled duplicate", async () => {
    const ids = await fixture();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId: ids.companyId,
      type: "request_board_approval",
      status: "approved",
      payload: {},
      decisionNote: "Approved by owner",
      decidedByUserId: "owner",
      decidedAt: new Date(),
    });
    await db.insert(issueApprovals).values({
      companyId: ids.companyId,
      issueId: ids.duplicateIssueId,
      approvalId,
    });
    await consolidate(ids);
    const linkedApproval = await db
      .select({
        issueId: issueApprovals.issueId,
        status: approvals.status,
        decidedByUserId: approvals.decidedByUserId,
      })
      .from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(eq(issueApprovals.approvalId, approvalId));
    expect(linkedApproval).toEqual([{
      issueId: ids.duplicateIssueId,
      status: "approved",
      decidedByUserId: "owner",
    }]);
  });
});
