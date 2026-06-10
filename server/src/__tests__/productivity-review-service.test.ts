import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  productivityReviewService,
} from "../services/productivity-review.js";
import { logActivity } from "../services/activity-log.js";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    monitorNextCheckAt?: Date | null;
    monitorScheduledBy?: "assignee" | "board" | null;
    parentId?: string | null;
    originKind?: string;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const companyId = randomUUID();
    const ownerUserId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date("2026-04-28T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Productivity Review Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: opts?.startedAt ?? createdAt,
      monitorNextCheckAt: opts?.monitorNextCheckAt ?? null,
      monitorScheduledBy: opts?.monitorScheduledBy ?? null,
      executionPolicy: opts?.executionPolicy ?? null,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, ownerUserId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
    contextSource?: string;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: input.contextSource
          ? { issueId: input.issueId, taskId: input.issueId, source: input.contextSource }
          : { issueId: input.issueId, taskId: input.issueId },
        livenessState: "advanced",
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    if (input.withRunComments) {
      await db.insert(issueComments).values(
        runs.map((run, index) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          authorAgentId: input.agentId,
          createdByRunId: run.id,
          body: `Progress update ${index}`,
          createdAt: run.createdAt as Date,
          updatedAt: run.createdAt as Date,
        })),
      );
    }

    return runs;
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listProductivityReviewEscalations(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, RECOVERY_ORIGIN_KINDS.productivityReviewEscalation)))
      .orderBy(issues.createdAt);
  }

  async function insertResolvedProductivityReviews(input: {
    companyId: string;
    sourceIssueId: string;
    issuePrefix: string;
    count: number;
    now: Date;
    ageMs?: number;
    status?: "done" | "cancelled";
    hiddenAt?: Date | null;
  }) {
    await db.insert(issues).values(
      Array.from({ length: input.count }, (_, index) => {
        const createdAt = new Date(input.now.getTime() - (input.ageMs ?? 7 * 60 * 60 * 1000) - index * 60_000);
        return {
          id: randomUUID(),
          companyId: input.companyId,
          title: `Resolved productivity review ${index}`,
          status: input.status ?? "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: input.sourceIssueId,
          originFingerprint: `productivity-review:${input.sourceIssueId}`,
          parentId: input.sourceIssueId,
          issueNumber: index + 10,
          identifier: `${input.issuePrefix}-${randomUUID().slice(0, 8)}`,
          hiddenAt: input.hiddenAt ?? null,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
  }

  it("creates exactly one manager-assigned review for a no-comment run streak and refreshes it idempotently", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(first.created).toBe(1);
    expect(second.updated).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.parentId).toBe(seeded.issueId);
    expect(reviews[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(reviews[0]?.originId).toBe(seeded.issueId);
    expect(reviews[0]?.originFingerprint).toBe(`productivity-review:${seeded.issueId}`);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, reviews[0]!.id));
    expect(comments.some((comment) => comment.body.includes("Productivity review evidence refreshed"))).toBe(true);
  });

  it("creates a long-active review without enabling a continuation hold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.priority).toBe("medium");
    expect(hold.held).toBe(false);
  });

  it("suppresses long-active productivity reviews for deliberate future monitor waits", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
    expect(activities[0]?.details).toMatchObject({
      trigger: "long_active_duration",
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorScheduledBy: "assignee",
    });
  });

  it("creates long-active productivity reviews when the scheduled monitor has expired", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 60_000),
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("does not suppress no-comment productivity reviews for future monitor waits", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
  });

  it("closes open long-active productivity reviews when the source has a deliberate future monitor", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "board",
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("done");
  });

  it("does not close open no-comment productivity reviews when the source has a deliberate future monitor", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "board",
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "high",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "no_comment_streak",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  it("creates a high-churn review even when every sampled run has a progress comment", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).toContain("Runs in rolling windows: 10/1h");
  });

  it("ignores non-assignee comments when evaluating high-churn productivity reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 9,
      now,
    });
    const managerRuns = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    await db.insert(issueComments).values(
      managerRuns.map((run, index) => ({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.managerId,
        createdByRunId: run.id,
        body: `Manager note ${index}`,
        createdAt: run.createdAt as Date,
        updatedAt: run.createdAt as Date,
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not create a repeat review from history alone when no current trigger exists", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "todo" });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Completed productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("isolates one candidate's review failure and continues reconciling other candidates", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const bad = await seedAssignedIssue();
    const good = await seedAssignedIssue();
    for (const seeded of [bad, good]) {
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
    }

    const result = await productivityReviewService(db, {
      beforeCreateOrUpdateReview(evidence) {
        if (evidence.sourceIssue.id === bad.issueId) throw new Error("synthetic review failure");
      },
    }).reconcileProductivityReviews({ now });

    expect(result.failed).toBe(1);
    expect(result.failedIssueIds).toEqual([bad.issueId]);
    expect(result.created).toBe(1);
    expect(await listProductivityReviews(bad.companyId)).toHaveLength(0);
    expect(await listProductivityReviews(good.companyId)).toHaveLength(1);
  });

  it("deduplicates concurrent productivity review creation for the same source", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const [first, second] = await Promise.all([
      productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId }),
      productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId }),
    ]);

    expect(first.created + second.created).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  for (const terminalStatus of ["done", "cancelled"] as const) {
    it(`suppresses a no_comment_streak review as an audit-only decision when the source is ${terminalStatus} (BLO-6243)`, async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const result = await productivityReviewService(db, {
        async beforeCreateOrUpdateReview(evidence) {
          if (evidence.sourceIssue.id === seeded.issueId) {
            await db
              .update(issues)
              .set({ status: terminalStatus })
              .where(eq(issues.id, seeded.issueId));
          }
        },
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      // No review issue is emitted and no generic skip is counted — the terminal source is a
      // distinct, attributable suppression.
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.suppressedTerminalSource).toBe(1);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

      const [source] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(source?.status).toBe(terminalStatus);

      // The suppression is recorded as an audit-only decision on the source issue.
      const suppressions = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]?.entityId).toBe(seeded.issueId);
      expect(suppressions[0]?.details).toMatchObject({
        decision: "suppress_terminal_source",
        sourceStatus: terminalStatus,
        trigger: "no_comment_streak",
      });
    });
  }

  it("keeps emitting a no_comment_streak review while the source stays in_progress (BLO-6243 control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.suppressedTerminalSource).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
    const suppressions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(suppressions).toHaveLength(0);
  });

  it("skips productivity-review descendants so reviews cannot recursively spawn reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const reviewId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Existing productivity review",
      status: "todo",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId: seeded.companyId,
      title: "Review follow-up child",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.coderId,
      parentId: reviewId,
      issueNumber: 3,
      identifier: `${seeded.issuePrefix}-3`,
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: childId,
      count: 10,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently completed review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(reviews).toHaveLength(1);
  });

  it("counts only visible done productivity reviews inside the escalation lookback", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 2,
      now,
      ageMs: 8 * 60 * 60 * 1000,
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 1,
      now,
      ageMs: 8 * 60 * 60 * 1000,
      status: "cancelled",
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 1,
      now,
      ageMs: 15 * 24 * 60 * 60 * 1000,
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 1,
      now,
      ageMs: 8 * 60 * 60 * 1000,
      hiddenAt: now,
    });

    const count = await productivityReviewService(db).countResolvedProductivityReviews(
      seeded.companyId,
      seeded.issueId,
      14 * 24 * 60 * 60 * 1000,
      now,
    );

    expect(count).toBe(2);
  });

  it("escalates at the repeat-review threshold and blocks the source issue", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 3,
      now,
      ageMs: 8 * 60 * 60 * 1000,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.escalated).toBe(1);
    const [escalation] = await listProductivityReviewEscalations(seeded.companyId);
    expect(escalation?.title).toContain(`[user-cover] productivity-review escalation: ${seeded.issuePrefix}-1`);
    expect(escalation?.assigneeUserId).toBe(seeded.ownerUserId);
    expect(escalation?.assigneeAgentId).toBeNull();
    expect(escalation?.originId).toBe(seeded.issueId);
    expect(escalation?.originFingerprint).toBe(`productivity-review-escalation:${seeded.issueId}`);
    expect(escalation?.parentId).toBe(seeded.issueId);
    expect(escalation?.description).toContain("3 prior resolved productivity reviews");
    expect(escalation?.description).toContain("cancel / hand off / decompose / let it run with the opt-out flag");

    const [source] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(source?.status).toBe("blocked");
    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, escalation!.id), eq(issueRelations.relatedIssueId, seeded.issueId)));
    expect(relations).toHaveLength(1);
  });

  it("backs off rather than escalating below the repeat-review threshold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 2,
      now,
      ageMs: 8 * 60 * 60 * 1000,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.escalated).toBe(0);
    expect(result.created).toBe(0);
    expect(result.snoozed).toBe(1);
    expect(await listProductivityReviewEscalations(seeded.companyId)).toHaveLength(0);
  });

  it("does not duplicate an existing open productivity-review escalation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 3,
      now,
      ageMs: 8 * 60 * 60 * 1000,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Existing escalation",
      status: "todo",
      priority: "high",
      assigneeUserId: seeded.ownerUserId,
      originKind: RECOVERY_ORIGIN_KINDS.productivityReviewEscalation,
      originId: seeded.issueId,
      originFingerprint: `productivity-review-escalation:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 99,
      identifier: `${seeded.issuePrefix}-99`,
      createdAt: now,
      updatedAt: now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.existing).toBe(1);
    expect(result.escalated).toBe(0);
    expect(await listProductivityReviewEscalations(seeded.companyId)).toHaveLength(1);
  });

  it("does not flip terminal source issues while escalating repeat reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "todo",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await db.update(issues).set({ status: "done", completedAt: now, updatedAt: now }).where(eq(issues.id, seeded.issueId));
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 3,
      now,
      ageMs: 8 * 60 * 60 * 1000,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.scanned).toBe(0);
    const [source] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(source?.status).toBe("done");
  });

  it("opt-out flag short-circuits the candidate before snooze and escalation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      executionPolicy: {
        monitor: {
          nextCheckAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
          productivityReviewDisabled: true,
        },
      },
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 3,
      now,
      ageMs: 30 * 60 * 1000,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.optedOut).toBe(1);
    expect(result.snoozed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.created).toBe(0);
  });

  it("keeps snoozing recent resolved reviews before escalation counting", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertResolvedProductivityReviews({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      issuePrefix: seeded.issuePrefix,
      count: 3,
      now,
      ageMs: 30 * 60 * 1000,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(await listProductivityReviewEscalations(seeded.companyId)).toHaveLength(0);
  });

  it("includes the hardened close-as-productive evidence gate in review markdown", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });

    await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("A \"Close as productive\" verdict requires at least ONE");
    expect(review?.description).toContain("An assignee run-linked comment in the last 6h that contains a `Next action:` line");
    expect(review?.description).toContain("Request decomposition (the work is too large for a single heartbeat issue and needs to be split)");
  });

  it("reports and logs soft-stop holds for open no-comment reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const [latestRun] = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(hold.held).toBe(true);
    if (!hold.held) return;

    await service.recordContinuationHold({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: latestRun!.id as string,
      agentId: seeded.coderId,
      reviewIssueId: review!.id,
      trigger: hold.trigger,
      reason: hold.reason,
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_continuation_held"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
  });

  it("honors resolvedSnoozeMs when the prior review was cancelled, not just done", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const cancelledReviewCreatedAt = new Date(now.getTime() - 30 * 60 * 1000);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Cancelled productivity review (manager closed as harness noise)",
      status: "cancelled",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: cancelledReviewCreatedAt,
      updatedAt: cancelledReviewCreatedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.snoozed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("backs off when the same source issue has two terminal productivity reviews in 24h", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: "First repeated productivity review",
        status: "done",
        priority: "high",
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: 2,
        identifier: `${seeded.issuePrefix}-2`,
        createdAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
      },
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: "Second repeated productivity review",
        status: "done",
        priority: "high",
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: 3,
        identifier: `${seeded.issuePrefix}-3`,
        createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      },
    ]);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.snoozed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("does not file a review when 100% of sampling-window runs are routine-origin", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      contextSource: "routine.dispatch",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("throttles refresh-evidence comments at the 5-minute hard floor (BLO-3281 AC2)", async () => {
    // Reproduces the 2026-05-05 BLO-3277 incident shape: detector
    // re-runs faster than 5 min apart should NOT keep adding refresh
    // comments. PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS gates the
    // addComment call inside createOrUpdateReview.
    //
    // The throttle compares the freshly-generated evidence's wall-clock
    // time to the DB-side createdAt of the latest refresh comment, both
    // of which are real-now in production. To exercise both branches in
    // a unit test without sleeping for 5 min, we backdate the latest
    // refresh comment via SQL UPDATE between scans.
    const seeded = await seedAssignedIssue();
    const scanNow = new Date();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: scanNow,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now: scanNow, companyId: seeded.companyId });
    expect(first.created).toBe(1);

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    const reviewId = reviews[0]!.id;

    async function countRefreshComments() {
      const rows = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, reviewId),
            sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
          ),
        );
      return rows.length;
    }

    const baselineRefreshCount = await countRefreshComments();
    expect(baselineRefreshCount).toBe(0);

    // Re-scan: latest refresh comment doesn't exist yet (no refresh on
    // the create path), so the throttle short-circuits and the existing
    // branch writes its first refresh comment.
    const firstRefresh = await service.reconcileProductivityReviews({ now: scanNow, companyId: seeded.companyId });
    expect(firstRefresh.updated).toBe(1);
    expect(await countRefreshComments()).toBe(1);

    // Within-floor re-scan: latest refresh just landed seconds ago.
    // Throttle should kick in — return existing, no new refresh comment.
    const throttled = await service.reconcileProductivityReviews({ now: new Date(), companyId: seeded.companyId });
    expect(throttled.existing).toBe(1);
    expect(throttled.updated).toBe(0);
    expect(await countRefreshComments()).toBe(1);

    // Backdate the latest refresh comment so the next reconcile sees
    // it as past the 5-min floor; throttle should release.
    const backdate = new Date(Date.now() - PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS - 60 * 1000);
    await db
      .update(issueComments)
      .set({ createdAt: backdate })
      .where(eq(issueComments.issueId, reviewId));

    const allowed = await service.reconcileProductivityReviews({ now: new Date(), companyId: seeded.companyId });
    expect(allowed.updated).toBe(1);
    expect(await countRefreshComments()).toBe(2);
  });

  it("clamps poisoned requestDepth metadata instead of aborting productivity reconciliation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(issues)
      .set({ requestDepth: 2_147_483_647 })
      .where(eq(issues.id, seeded.issueId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.failed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });
});
