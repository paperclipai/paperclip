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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  evaluateNoCommentStreakSuppression,
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
  }, 30_000);

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
    /** RBR-1013: override the run's (finishedAt - startedAt) duration to
     * simulate a run that outlived its agent JWT before it finished. */
    durationMs?: number;
    /** RBR-1013: override the spacing between consecutive runs' createdAt.
     * Defaults to 60s. A wider gap keeps a 10-run streak below the default
     * high-churn thresholds so a no_comment_streak suppression test isn't
     * confounded by high_churn also firing. */
    gapMs?: number;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * (input.gapMs ?? 60_000));
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + (input.durationMs ?? 30_000)),
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

  it("allows only one productivity review per source issue in 24 hours", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const createdAt = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Completed productivity review",
      status: "done",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt,
      updatedAt: createdAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.creationCapped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("suppresses creation after three consecutive completed reviews with no source action", async () => {
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
      [96, 72, 48].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `No-action productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("resets no-action suppression for source action after a zero-duration review", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [96, 72, 48].map((hoursAgo, index) => {
      const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
      };
    });
    const actedReview = reviewWindows[1]!;
    actedReview.updatedAt = actedReview.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(actedReview.createdAt.getTime() + 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.noActionSuppressed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("uses review creation order for no-action streak windows", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [
      { hoursAgo: 96, updatedAt: new Date(now.getTime() - 95 * 60 * 60 * 1000) },
      { hoursAgo: 72, updatedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000) },
      { hoursAgo: 48, updatedAt: new Date(now.getTime() - 47 * 60 * 60 * 1000) },
    ].map((window, index) => {
      const createdAt = new Date(now.getTime() - window.hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ordered window ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: window.updatedAt,
      };
    });
    const middleReviewCreatedAt = reviewWindows[1]!.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(middleReviewCreatedAt.getTime() + 60_000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { maxConsecutiveNoActionReviews: 1 },
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
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

  it("treats a recently cancelled review as a snooze window", async () => {
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
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
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

  // RBR-1013 (RBR-977 scope item 4) — the no_comment_streak observation must
  // be suppressed, not turned into a review, when it is unattributable to
  // the agent.
  it("suppresses no_comment_streak when the sample window's API p50 exceeded threshold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      // Wider gap keeps runCountLastHour below the high-churn threshold so
      // this test isolates the no_comment_streak suppression path.
      gapMs: 8 * 60_000,
    });
    // RBR-977 measured a single POST taking 101.4s under load.
    const service = productivityReviewService(db, { readApiP50Ms: () => 101_400 });

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("suppresses no_comment_streak when a streak run outlived the agent JWT TTL", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // RBR-977's run reached 3813s against a 1h (3600s) JWT TTL.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      durationMs: 3_813_000,
      gapMs: 8 * 60_000,
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // Greptile P1 on PR #11028: the API-latency sample window must be anchored
  // at the streak's own end (newest streak run's finish), not at "now"/the
  // reconciliation pass's own wall-clock time. A slow unrelated request that
  // lands in the gap *after* the streak's last run finished but *before*
  // reconciliation happens to run must never retroactively explain (and
  // suppress) a genuine no-comment streak it never overlapped. Asserted via
  // spy on the exact `at` anchor passed to the latency reader — proving the
  // call site's anchoring itself, not just an end-to-end outcome a stub
  // could coincidentally satisfy either way.
  it("anchors the no_comment_streak latency sample at the streak's own end, not at reconciliation time", async () => {
    const runsAnchor = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const runs = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: runsAnchor,
      gapMs: 8 * 60_000,
    });
    const newestRunFinishedAt = runs[0]!.finishedAt as Date;
    // Reconciliation runs a full hour after the streak's last run finished —
    // plenty of room for an unrelated slow request to land in that gap.
    const reconcileNow = new Date(newestRunFinishedAt.getTime() + 60 * 60_000);

    const calls: Array<{ windowMs?: number; companyId?: string; at?: number }> = [];
    const service = productivityReviewService(db, {
      readApiP50Ms: (windowMs, companyId, at) => {
        calls.push({ windowMs, companyId, at });
        return 200;
      },
    });

    const result = await service.reconcileProductivityReviews({ now: reconcileNow, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    expect(calls).toHaveLength(1);
    // The fixed call site must anchor at the streak's own end, not at
    // reconciliation's wall-clock time — a pre-fix call site either omits
    // `at` entirely or passes `reconcileNow`, both of which this assertion
    // rejects.
    expect(calls[0]!.at).toBe(newestRunFinishedAt.getTime());
    expect(calls[0]!.at).not.toBe(reconcileNow.getTime());
  });

  it(
    "negative control: still creates a no_comment_streak review when neither suppression cause applies",
    async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        gapMs: 8 * 60_000,
      });
      // Healthy API latency and short run durations — this is the
      // no-guard-removed control proving the two suppression tests above
      // are actually exercising the guard, not a monitor that never fires.
      const service = productivityReviewService(db, { readApiP50Ms: () => 200 });

      const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
    },
  );

  it("does not suppress on latency alone when there is no API sample data (null is unknown, not degraded)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      gapMs: 8 * 60_000,
    });
    const service = productivityReviewService(db, { readApiP50Ms: () => null });

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
  });

  it("honors a configurable API p50 threshold for no_comment_streak suppression", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      gapMs: 8 * 60_000,
    });
    // 800ms is healthy against the module default (5000ms) but this test
    // lowers the threshold to 500ms to prove the override is consulted.
    const service = productivityReviewService(db, { readApiP50Ms: () => 800 });

    const result = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { apiP50ThresholdMs: 500 },
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });
});

describe("evaluateNoCommentStreakSuppression", () => {
  const thresholds = {
    noCommentStreakRuns: 10,
    longActiveMs: 1,
    highChurnHourly: 1,
    highChurnSixHours: 1,
    resolvedSnoozeMs: 1,
    refreshIntervalMs: 1,
    maxRefreshComments: 1,
    creationWindowMs: 1,
    maxCreationsPerWindow: 1,
    maxConsecutiveNoActionReviews: 1,
    apiP50ThresholdMs: 5_000,
    jwtTtlMs: 60 * 60 * 1000,
  };

  it("is not suppressed when neither cause applies", () => {
    const decision = evaluateNoCommentStreakSuppression({
      streakRuns: [{
        id: "run-1",
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        createdAt: new Date(0),
        startedAt: new Date(0),
        finishedAt: new Date(30_000),
        nextAction: null,
        usageJson: null,
      }] as never,
      apiP50Ms: 200,
      thresholds,
    });
    expect(decision.reasons).toEqual([]);
  });

  it("flags degraded_window_api_latency when p50 exceeds threshold", () => {
    const decision = evaluateNoCommentStreakSuppression({
      streakRuns: [],
      apiP50Ms: 101_400,
      thresholds,
    });
    expect(decision.reasons).toEqual(["degraded_window_api_latency"]);
  });

  it("flags run_credential_expired when a streak run outlived the JWT TTL", () => {
    const decision = evaluateNoCommentStreakSuppression({
      streakRuns: [{
        id: "run-1",
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        createdAt: new Date(0),
        startedAt: new Date(0),
        finishedAt: new Date(3_813_000), // RBR-977's measured run duration
        nextAction: null,
        usageJson: null,
      }] as never,
      apiP50Ms: null,
      thresholds,
    });
    expect(decision.reasons).toEqual(["run_credential_expired"]);
    expect(decision.credentialExpiredRunIds).toEqual(["run-1"]);
  });

  it("does not flag run_credential_expired for a run missing timestamps", () => {
    const decision = evaluateNoCommentStreakSuppression({
      streakRuns: [{
        id: "run-1",
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        createdAt: new Date(0),
        startedAt: null,
        finishedAt: null,
        nextAction: null,
        usageJson: null,
      }] as never,
      apiP50Ms: null,
      thresholds,
    });
    expect(decision.reasons).toEqual([]);
  });
});

