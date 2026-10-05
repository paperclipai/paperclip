import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog configuration revisions tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog configuration revisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  let issueNumber = 0;

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "done",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WDOG-${++issueNumber}`,
      issueNumber: overrides.issueNumber ?? issueNumber,
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      originFingerprint: overrides.originFingerprint,
      updatedAt: overrides.updatedAt,
      // Default to an "established" issue (created well before the first-run
      // grace window) so the pending-first-run guard does not defer it. Tests
      // exercising the create-race pass an explicit recent `createdAt`.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
    }).returning();
    return row;
  }

  async function setup(status = "done", delivery: "ok" | "null" | "throw" = "ok") {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { status, identifier: `CONFIG-${randomUUID()}`, issueNumber: 1000 });
    const row = await seedWatchdog(companyId, sourceId, agentId);
    const wakes: string[] = [];
    const service = taskWatchdogService(db, { enqueueWakeup: async (agent) => {
      wakes.push(agent);
      if (delivery === "throw") throw new Error("audit-delivery-failure");
      return delivery === "null" ? null : { id: randomUUID() };
    }});
    return { companyId, agentId, sourceId, row, service, wakes };
  }
  async function persisted(id: string) {
    return (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, id)))[0]!;
  }
  async function scope(x: Awaited<ReturnType<typeof setup>>) {
    const row = await persisted(x.row.id);
    return { kind: "watchdog" as const, watchdogId: row.id, companyId: x.companyId,
      watchedIssueId: x.sourceId, stopFingerprint: row.lastObservedFingerprint };
  }
  async function reviewed(x: Awaited<ReturnType<typeof setup>>) {
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const row = await persisted(x.row.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, row.watchdogIssueId!));
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    expect((await persisted(row.id)).lastReviewedFingerprint).toBe(row.lastObservedFingerprint);
  }

  it("reopens a completed review when its instructions change", async () => {
    const x = await setup(); await reviewed(x);
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: x.agentId, instructions: "NEW acceptance criteria" });
    const result = await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    expect(result.triggered).toBe(1); expect(x.wakes).toHaveLength(2);
  });
  it("transfers an idle open review to the newly configured agent", async () => {
    const x = await setup("done", "null");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const newAgent = await seedAgent(x.companyId);
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: newAgent, instructions: "Verify again" });
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
    const row = await persisted(x.row.id);
    const review = (await db.select().from(issues).where(eq(issues.id, row.watchdogIssueId!)))[0]!;
    expect(row.watchdogAgentId).toBe(newAgent); expect(review.assigneeAgentId).toBe(newAgent);
    expect(x.wakes).toEqual([x.agentId, newAgent]);
  });
  it("rejects the prior configuration's mutation scope after an agent change", async () => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const captured = await scope(x);
    const newAgent = await seedAgent(x.companyId);
    await x.service.upsertForIssue(x.companyId, x.sourceId, {
      agentId: newAgent, instructions: "Changed acceptance criteria",
    });
    expect((await x.service.revalidateMutationScope(captured)).allowed).toBe(false);
  });
  it("keeps a completed review for the same normalized configuration", async () => {
    const x = await setup();
    await reviewed(x);
    const before = await persisted(x.row.id);
    await x.service.upsertForIssue(x.companyId, x.sourceId, {
      agentId: x.agentId, instructions: "  Verify stopped work.  ",
    });
    const after = await persisted(x.row.id);
    expect(after.configurationRevision).toBe(0);
    expect(after.lastReviewedFingerprint).toBe(before.lastReviewedFingerprint);
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).alreadyReviewed).toBe(1);
    expect(x.wakes).toHaveLength(1);
  });

  it("does not restore an old scope when the configuration changes from A to B and back to A", async () => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const oldScope = await scope(x);
    const agentB = await seedAgent(x.companyId);
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: agentB, instructions: "Verify stopped work." });
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: x.agentId, instructions: "Verify stopped work." });
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    expect((await persisted(x.row.id)).configurationRevision).toBe(2);
    expect((await x.service.revalidateMutationScope(oldScope)).allowed).toBe(false);
    expect((await x.service.revalidateMutationScope(await scope(x))).allowed).toBe(true);
    expect(x.wakes).toEqual([x.agentId, agentB, x.agentId]);
  });

  it.each(["legacy", "native"] as const)("waits for the old %s review run and does not credit its completion to the new configuration", async (runtimeMode) => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const original = await persisted(x.row.id);
    const oldScope = await scope(x);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: x.companyId, agentId: x.agentId, status: "running",
      runtimeMode,
      ...(runtimeMode === "native" ? {
        nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified",
      } : {}),
      contextSnapshot: { issueId: original.watchdogIssueId },
    });
    const agentB = await seedAgent(x.companyId);
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: agentB, instructions: "New criteria" });
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).live).toBe(1);
    expect(x.wakes).toHaveLength(1);
    expect((await x.service.revalidateMutationScope(oldScope)).allowed).toBe(false);
    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stillRunning!.status).toBe("running");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, original.watchdogIssueId!));
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
    expect((await persisted(x.row.id)).lastReviewedFingerprint).toBeNull();
    expect(x.wakes).toEqual([x.agentId, agentB]);
  });

  it("invalidates the old scope when a disabled watchdog is enabled again", async () => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const originalScope = await scope(x);
    await x.service.disableForIssue(x.companyId, x.sourceId);
    await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: x.agentId, instructions: "Verify stopped work." });
    expect((await persisted(x.row.id)).configurationRevision).toBe(1);
    expect((await x.service.revalidateMutationScope(originalScope)).allowed).toBe(false);
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
  });

  it("counts concurrent distinct configuration saves against the current row", async () => {
    const x = await setup();
    const agentB = await seedAgent(x.companyId);
    const agentC = await seedAgent(x.companyId);
    await Promise.all([
      x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: agentB, instructions: "B criteria" }),
      x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: agentC, instructions: "C criteria" }),
    ]);
    const saved = await persisted(x.row.id);
    expect(saved.configurationRevision).toBe(2);
    expect([agentB, agentC]).toContain(saved.watchdogAgentId);
  });

  it.each([false, true])("does not publish a stale evaluation (existing review: %s)", async (existingReview) => {
    const x = await setup("blocked");
    if (existingReview) {
      await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
      const first = await persisted(x.row.id);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.watchdogIssueId!));
    }
    const beforeReviews = await db.select().from(issues).where(eq(issues.originId, x.sourceId));
    const beforeComments = await db.select().from(issueComments);
    const wakeCount = x.wakes.length;
    const agentB = await seedAgent(x.companyId);
    let changePending = true;
    const intercepted = new Proxy(db, {
      get(target, key) {
        if (key === "execute") return async (...args: Parameters<typeof db.execute>) => {
          const result = await target.execute(...args);
          if (changePending) {
            changePending = false;
            await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: agentB, instructions: "New criteria" });
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = taskWatchdogService(intercepted, { enqueueWakeup: async (agentId) => {
      x.wakes.push(agentId);
      return { id: randomUUID() };
    } });
    expect((await service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(0);
    expect((await persisted(x.row.id)).lastObservedFingerprint).toBeNull();
    expect(x.wakes).toHaveLength(wakeCount);
    expect(await db.select().from(issues).where(eq(issues.originId, x.sourceId))).toEqual(beforeReviews);
    expect(await db.select().from(issueComments)).toEqual(beforeComments);
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
    expect(x.wakes.slice(wakeCount)).toEqual([agentB]);
  });

  it("counts concurrent identical saves only once", async () => {
    const x = await setup();
    const agentB = await seedAgent(x.companyId);
    await Promise.all(Array.from({ length: 4 }, () => x.service.upsertForIssue(x.companyId, x.sourceId, {
      agentId: agentB, instructions: "New criteria",
    })));
    expect((await persisted(x.row.id)).configurationRevision).toBe(1);
  });

  it("rejects a configuration edit during mutation revalidation", async () => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const oldScope = await scope(x);
    let editPending = true;
    const intercepted = new Proxy(db, {
      get(target, key) {
        if (key === "execute") return async (...args: Parameters<typeof db.execute>) => {
          const result = await target.execute(...args);
          if (editPending) {
            editPending = false;
            await x.service.upsertForIssue(x.companyId, x.sourceId, {
              agentId: x.agentId, instructions: "New criteria",
            });
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await taskWatchdogService(intercepted).revalidateMutationScope(oldScope);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("configuration changed");
  });

  it("preserves a legacy reviewed fingerprint when the generated migration runs", async () => {
    const x = await setup();
    await reviewed(x);
    const before = await persisted(x.row.id);
    expect(before.lastReviewedFingerprint).not.toContain(":config:");
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0295_living_magneto.sql", import.meta.url), "utf8");
    // Removing only the new column restores the previous table shape. Apply
    // the actual generated migration to populated legacy review data.
    await db.execute(sql`ALTER TABLE issue_watchdogs DROP COLUMN configuration_revision`);
    try {
      await db.execute(sql.raw(migration));
    } finally {
      await db.execute(sql`ALTER TABLE issue_watchdogs ADD COLUMN IF NOT EXISTS configuration_revision integer DEFAULT 0 NOT NULL`);
    }
    const after = await persisted(x.row.id);
    expect(after.configurationRevision).toBe(0);
    expect(after.lastReviewedFingerprint).toBe(before.lastReviewedFingerprint);
    expect(after.lastReviewedStopSnapshot).toEqual(before.lastReviewedStopSnapshot);
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).alreadyReviewed).toBe(1);
    expect(x.wakes).toHaveLength(1);
  });

  it("does not change configuration for an agent in another company", async () => {
    const x = await setup();
    const otherAgent = await seedAgent(await seedCompany());
    await expect(x.service.upsertForIssue(x.companyId, x.sourceId, {
      agentId: otherAgent, instructions: "Other company",
    })).rejects.toThrow();
    const after = await persisted(x.row.id);
    expect(after.configurationRevision).toBe(0);
    expect(after.watchdogAgentId).toBe(x.agentId);
  });

  it("denies an old wake scope when configuration changes at the external dispatch boundary", async () => {
    const x = await setup("blocked");
    const agentB = await seedAgent(x.companyId);
    let captured: Awaited<ReturnType<typeof scope>> | undefined;
    const service = taskWatchdogService(db, { enqueueWakeup: async () => {
      captured = await scope(x);
      await x.service.upsertForIssue(x.companyId, x.sourceId, {
        agentId: agentB, instructions: "New criteria",
      });
      return { id: randomUUID() };
    } });
    await service.reconcileTaskWatchdogs({ companyId: x.companyId });
    expect(captured).toBeDefined();
    expect((await x.service.revalidateMutationScope(captured!)).allowed).toBe(false);
    expect((await persisted(x.row.id)).lastObservedFingerprint).toBeNull();
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
    expect(x.wakes).toEqual([agentB]);
  });

  it.each((["interaction", "approval", "human"] as const).flatMap((kind) =>
    (["configuration", "subtree"] as const).map((change) => ({ kind, change }))))(
    "preserves a pending $kind review across $change changes", async ({ kind, change }) => {
    const x = await setup("blocked");
    await x.service.reconcileTaskWatchdogs({ companyId: x.companyId });
    const original = await persisted(x.row.id);
    const reviewId = original.watchdogIssueId!;
    await db.update(issues).set({ status: "in_review", ...(kind === "human" ? {
      assigneeAgentId: null, assigneeUserId: "reviewer",
    } : {}) }).where(eq(issues.id, reviewId));
    const pendingId = randomUUID();
    if (kind === "interaction") await db.insert(issueThreadInteractions).values({
      id: pendingId, companyId: x.companyId, issueId: reviewId,
      kind: "request_confirmation", status: "pending",
      payload: { version: 1, prompt: "Confirm the prior review." }, createdByAgentId: x.agentId,
    });
    if (kind === "approval") {
      await db.insert(approvals).values({ id: pendingId, companyId: x.companyId,
        type: "request_board_approval", status: "pending", payload: { summary: "Approve the review" },
      });
      await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: reviewId, approvalId: pendingId });
    }
    const newAgent = change === "configuration" ? await seedAgent(x.companyId) : x.agentId;
    if (change === "configuration") {
      await x.service.upsertForIssue(x.companyId, x.sourceId, { agentId: newAgent, instructions: "New criteria" });
    } else {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, x.sourceId));
      expect((await x.service.revalidateMutationScope(await scope(x))).allowed).toBe(false);
    }
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(0);
    const [review] = await db.select().from(issues).where(eq(issues.id, reviewId));
    expect(review!.status).toBe("in_review");
    expect(review!.originFingerprint).toBe(original.lastObservedFingerprint);
    expect(review!.assigneeAgentId).toBe(kind === "human" ? null : x.agentId);
    expect(review!.assigneeUserId).toBe(kind === "human" ? "reviewer" : null);
    expect(x.wakes).toHaveLength(1);
    if (kind === "interaction") {
      const [pending] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pendingId));
      expect(pending!.status).toBe("pending");
      await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, pendingId));
    }
    if (kind === "approval") {
      const [pending] = await db.select().from(approvals).where(eq(approvals.id, pendingId));
      expect(pending!.status).toBe("pending");
      await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, pendingId));
    }
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, reviewId));
    expect((await x.service.reconcileTaskWatchdogs({ companyId: x.companyId })).triggered).toBe(1);
    expect((await persisted(x.row.id)).lastReviewedFingerprint).toBe(
      change === "configuration" ? null : original.lastObservedFingerprint,
    );
    expect(x.wakes).toEqual([x.agentId, newAgent]);
  });

  it("finishes concurrent evaluations without re-entering an exhausted connection pool", async () => {
    const x = await setup("blocked");
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      x.service.reconcileTaskWatchdogs({ companyId: x.companyId })));
    expect(results.reduce((sum, result) => sum + result.triggered, 0)).toBe(1);
    expect(await db.select().from(issues).where(eq(issues.originId, x.sourceId))).toHaveLength(1);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(x.wakes).toHaveLength(1);
  });

});
