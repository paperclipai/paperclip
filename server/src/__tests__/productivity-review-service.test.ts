import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS,
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  productivityReviewService,
} from "../services/productivity-review.ts";

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
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    parentId?: string | null;
    originKind?: string;
  }) {
    const companyId = randomUUID();
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
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
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
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
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

  /**
   * Inserts runs that died on a provider-quota refusal (HTTP 429 / token-plan
   * exhaustion). These runs never started, so they cannot have commented on
   * anything - they must not count toward the no-comment streak (TON-981).
   */
  async function insertQuotaFailedRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    /** "structured" carries the explicit error code, "text" only the 429 message. */
    shape?: "structured" | "text";
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      const structured = (input.shape ?? "structured") === "structured";
      runs.push({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        status: "failed",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 5_000),
        error: "429 Token Plan usage limit reached",
        errorCode: structured ? "provider_quota" : "adapter_failed",
        resultJson: structured ? { errorFamily: "provider_quota" } : {},
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);
    return runs;
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listRefreshComments(reviewIssueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, reviewIssueId),
        sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
      ))
      .orderBy(issueComments.createdAt);
  }

  it("creates exactly one manager-assigned review for a no-comment run streak and rate-limits immediate refresh", async () => {
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
    expect(second.updated).toBe(0);
    expect(second.existing).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.parentId).toBe(seeded.issueId);
    expect(reviews[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(reviews[0]?.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
    expect(reviews[0]?.originId).toBe(seeded.issueId);
    expect(reviews[0]?.originFingerprint).toBe(`productivity-review:${seeded.issueId}`);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");

    expect(await listRefreshComments(reviews[0]!.id)).toHaveLength(0);
  });

  it("does not fire a no-comment streak when every sampled run died on a provider quota", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertQuotaFailedRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS * 2,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    // The runs never started, so they cannot be counted as agent silence.
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not fire a no-comment streak when quota failures only carry the 429 error text", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertQuotaFailedRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS * 2,
      now,
      shape: "text",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not let quota-failed runs break a real no-comment streak", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Real, completed runs that produced no comment - these DO count.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(now.getTime() - 60 * 60 * 1000),
    });
    // Quota failures are newer than the real runs; they must be skipped
    // entirely rather than terminating the streak.
    await insertQuotaFailedRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 5,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");
    expect(reviews[0]?.description).toContain(
      "Provider-quota-failed runs excluded from the sample: 5",
    );
  });

  it("refreshes open productivity reviews only once per interval and caps refresh comments", async () => {
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
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const firstRefreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
    const firstRefresh = await service.reconcileProductivityReviews({
      now: firstRefreshAt,
      companyId: seeded.companyId,
    });
    const tooSoonRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 2 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    const cappedRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 3 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });

    expect(firstRefresh.updated).toBe(1);
    expect(tooSoonRefresh.updated).toBe(0);
    expect(tooSoonRefresh.existing).toBe(1);
    expect(cappedRefresh.updated).toBe(0);
    expect(cappedRefresh.existing).toBe(1);
    expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);
  });

  it("caps productivity review creation per source issue in the rolling creation window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      // Older than the resolved-review snooze window so this exercises the creation cap
      // rather than the snooze.
      [13, 14, 15].map((hoursAgo, index) => {
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
    expect(result.creationCapped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("does not count cancelled productivity reviews toward the creation cap", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Cancelled productivity review ${index + 1}`,
          status: "cancelled",
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

    expect(result.created).toBe(1);
    expect(result.creationCapped).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
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

  it("creates a high-churn review even when every sampled run has a progress comment", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
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

  it("does not trip long_active_duration while the source issue has a live continuation path", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const service = productivityReviewService(db);

    const scenarios: Array<{
      label: string;
      seed: (seeded: Awaited<ReturnType<typeof seedAssignedIssue>>) => Promise<void>;
    }> = [
      {
        label: "armed monitor",
        seed: async (seeded) => {
          await db
            .update(issues)
            .set({ monitorNextCheckAt: new Date(now.getTime() + 60 * 60 * 1000) })
            .where(eq(issues.id, seeded.issueId));
        },
      },
      {
        label: "armed monitor in the execution policy",
        seed: async (seeded) => {
          await db
            .update(issues)
            .set({
              executionPolicy: {
                monitor: { nextCheckAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString() },
              },
            })
            .where(eq(issues.id, seeded.issueId));
        },
      },
      {
        label: "open descendant",
        seed: async (seeded) => {
          await db.insert(issues).values({
            id: randomUUID(),
            companyId: seeded.companyId,
            title: "Follow-up child",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: seeded.coderId,
            parentId: seeded.issueId,
            issueNumber: 2,
            identifier: `${seeded.issuePrefix}-2`,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        },
      },
      {
        label: "active routine",
        seed: async (seeded) => {
          await db.insert(routines).values({
            id: randomUUID(),
            companyId: seeded.companyId,
            title: "Daily watch",
            status: "active",
            assigneeAgentId: seeded.coderId,
            parentIssueId: seeded.issueId,
            variables: [],
          });
        },
      },
      {
        label: "pending interaction",
        seed: async (seeded) => {
          await db.insert(issueThreadInteractions).values({
            id: randomUUID(),
            companyId: seeded.companyId,
            issueId: seeded.issueId,
            kind: "ask_user_questions",
            status: "pending",
            continuationPolicy: "wake_assignee",
            payload: {
              version: 1,
              title: "Which lane?",
              questions: [
                {
                  id: "q1",
                  prompt: "Which lane should run next?",
                  selectionMode: "single",
                  options: [
                    { id: "a", label: "Lane A" },
                    { id: "b", label: "Lane B" },
                  ],
                },
              ],
            },
            createdAt: now,
            updatedAt: now,
          });
        },
      },
      {
        label: "live execution run",
        seed: async (seeded) => {
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId: seeded.companyId,
            agentId: seeded.coderId,
            status: "running",
            invocationSource: "assignment",
            triggerDetail: "system",
            startedAt: now,
            contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
            livenessState: "advanced",
            nextAction: "Continue processing the next batch.",
            createdAt: now,
            updatedAt: now,
          });
          await db
            .update(issues)
            .set({ executionRunId: runId })
            .where(eq(issues.id, seeded.issueId));
        },
      },
    ];

    for (const scenario of scenarios) {
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      });
      await scenario.seed(seeded);

      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const reviews = await listProductivityReviews(seeded.companyId);

      expect({ scenario: scenario.label, created: result.created }).toEqual({
        scenario: scenario.label,
        created: 0,
      });
      expect({ scenario: scenario.label, reviews: reviews.length }).toEqual({
        scenario: scenario.label,
        reviews: 0,
      });
    }
  });

  it("still trips long_active_duration when the source issue has no continuation path", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.created).toBe(1);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("keeps the resolved-review snooze longer than the long-active threshold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    expect(DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS).toBeGreaterThan(
      DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
    );

    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review).toBeTruthy();
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    // Past the long-active threshold (6h) but still inside the snooze window (12h):
    // the resolved review must suppress a re-review.
    const insideSnooze = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
      companyId: seeded.companyId,
    });
    expect(insideSnooze.snoozed).toBe(1);
    expect(insideSnooze.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);

    // Past the snooze window the review may be re-created.
    const afterSnooze = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS + 60 * 60 * 1000),
      companyId: seeded.companyId,
    });
    expect(afterSnooze.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("anchors the resolved-review snooze to the resolution time, not to later touches", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review).toBeTruthy();

    // Resolved at `now`, exactly as the issue service records a `done` transition.
    await db
      .update(issues)
      .set({ status: "done", completedAt: now, updatedAt: now })
      .where(eq(issues.id, review!.id));

    // A later touch of the closed review (a comment, a run lock, a field edit) bumps
    // `updated_at`. That must not extend - or re-arm - the snooze window.
    const touchedAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    await db.update(issues).set({ updatedAt: touchedAt }).where(eq(issues.id, review!.id));

    // The 12h window is measured from the RESOLUTION, so it has expired by now even
    // though the row was touched 6h after it was resolved.
    const afterWindow = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS + 60 * 60 * 1000),
      companyId: seeded.companyId,
    });
    expect(afterWindow.snoozed).toBe(0);
    expect(afterWindow.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("leaves no resolved-review bookkeeping behind when a done review is reopened", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review).toBeTruthy();

    // Transient resolution followed by an immediate revert to open: the bulk-close
    // accident. The revert must clear the resolved-review state entirely.
    await db
      .update(issues)
      .set({ status: "done", completedAt: now, updatedAt: now })
      .where(eq(issues.id, review!.id));
    await db
      .update(issues)
      .set({ status: "todo", completedAt: null, updatedAt: new Date(now.getTime() + 60 * 1000) })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    // Not snoozed: the reopened review is the live carrier again, so the trigger is
    // visible instead of being swallowed by a stale resolved-review window.
    expect(result.snoozed).toBe(0);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });
});
