import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueWorkProducts,
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
  productivityReviewService,
} from "../services/productivity-review.ts";
import { buildCommitGrepPattern } from "../services/productivity-review-work-trace.ts";

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
    issuePrefix?: string;
    issueNumber?: number;
    title?: string;
    createdAt?: Date;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = opts?.issuePrefix ?? `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueNumber = opts?.issueNumber ?? 1;
    const createdAt = opts?.createdAt ?? new Date("2026-04-28T10:00:00.000Z");

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
      title: opts?.title ?? "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
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

  describe("work-trace counter-check (AUR-1387)", () => {
    const tempRepos: string[] = [];

    afterAll(() => {
      for (const repoPath of tempRepos) {
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    /** A real git repo, so the counter-check exercises real `git log --grep`, not a stub. */
    function createRepoWithCommit(input: { subject: string; committedAt: string }) {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-work-trace-"));
      tempRepos.push(repoPath);
      const git = (args: string[]) =>
        execFileSync("git", ["-C", repoPath, ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Coder",
            GIT_AUTHOR_EMAIL: "coder@example.test",
            GIT_COMMITTER_NAME: "Coder",
            GIT_COMMITTER_EMAIL: "coder@example.test",
            GIT_AUTHOR_DATE: input.committedAt,
            GIT_COMMITTER_DATE: input.committedAt,
          },
          encoding: "utf8",
        });
      git(["init", "--initial-branch=master", "--quiet"]);
      fs.writeFileSync(path.join(repoPath, "addon.py"), "# pricelists addon\n");
      git(["add", "."]);
      git(["commit", "--quiet", "-m", input.subject]);
      const sha = git(["rev-parse", "HEAD"]).trim();
      return { repoPath, sha };
    }

    /**
     * The AUR-1370 timeline: one failed run right after checkout, the deliverable committed 2h
     * later, then nothing until the detector fired 1d19h into the episode.
     */
    async function seedUnreportedCompletionCase() {
      const startedAt = new Date("2026-07-26T05:15:08.507Z");
      const now = new Date("2026-07-28T01:05:46.933Z");
      const seeded = await seedAssignedIssue({
        issuePrefix: "AUR",
        issueNumber: 1370,
        title: "AUR-771 Phase 1: Addon aurdvin_pricelists bauen",
        createdAt: new Date("2026-07-26T05:15:08.293Z"),
        startedAt,
      });
      await db.insert(heartbeatRuns).values([
        {
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          status: "failed",
          invocationSource: "assignment",
          triggerDetail: "system",
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 60_000),
          contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
          livenessState: "failed",
          createdAt: new Date("2026-07-26T05:15:08.427Z"),
          updatedAt: new Date("2026-07-26T05:16:08.427Z"),
        },
        {
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          status: "running",
          invocationSource: "timer",
          triggerDetail: "system",
          startedAt: now,
          contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
          createdAt: new Date("2026-07-28T01:05:46.781Z"),
          updatedAt: new Date("2026-07-28T01:05:46.781Z"),
        },
      ]);
      return { seeded, now, startedAt };
    }

    it("classifies the AUR-1370 shape as unreported_completion instead of a stall", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const { repoPath, sha } = createRepoWithCommit({
        subject: "feat(aur1370): Addon aurdvin_pricelists — Handel/Promo-Fixpreise eingefroren (AUR-771 Phase 1)",
        committedAt: "2026-07-26T07:31:26+02:00",
      });

      const result = await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.title).toBe("Report and close finished work on AUR-1370");
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).not.toContain("Classification: `stall`");
      expect(review?.description).toContain(sha.slice(0, 7));
      expect(review?.description).toContain("Do **not** reassign, decompose, or restart");
      // The failed run is named as the cause, instead of "agent unresponsive".
      expect(review?.description).toContain("This failed run — not an unresponsive agent —");
      // The assignee owns the loose end, so no manager can reassign finished work.
      expect(review?.assigneeAgentId).toBe(seeded.coderId);
      expect(review?.priority).toBe("medium");

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_created"));
      expect((activity?.details as Record<string, unknown>)?.classification).toBe("unreported_completion");
      expect((activity?.details as Record<string, unknown>)?.workTraceCommitCount).toBe(1);
    });

    it("still reports a stall when the repo carries no commit for the issue key", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const { repoPath } = createRepoWithCommit({
        subject: "docs(aur1371): unrelated neighbour issue",
        committedAt: "2026-07-26T07:31:26+02:00",
      });

      const result = await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      expect(result.created).toBe(1);
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.title).toBe("Review productivity for AUR-1370");
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Commits carrying the issue key: none");
      expect(review?.description).toContain("Manager Decision");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_created"));
      expect((activity?.details as Record<string, unknown>)?.classification).toBe("stall");
      expect((activity?.details as Record<string, unknown>)?.workTraceCommitCount).toBe(0);
    });

    it("still reports a stall when the issue key only appears in commits predating in_progress", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): groundwork committed before the issue started",
        committedAt: "2026-07-20T09:00:00+02:00",
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Commits carrying the issue key: none");
    });

    /** An empty repo, so only the artifact side of the counter-check is under test. */
    function createEmptyRepoPath() {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-work-trace-empty-"));
      tempRepos.push(repoPath);
      return repoPath;
    }

    async function insertPlanningDocument(input: { companyId: string; issueId: string }) {
      const documentId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId: input.companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan",
        createdAt: new Date("2026-07-26T06:00:00.000Z"),
        updatedAt: new Date("2026-07-26T06:00:00.000Z"),
      });
      await db.insert(issueDocuments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        documentId,
        key: "plan",
        createdAt: new Date("2026-07-26T06:00:00.000Z"),
        updatedAt: new Date("2026-07-26T06:00:00.000Z"),
      });
    }

    // The protective direction: the agent that is genuinely stuck is the one that writes a plan
    // first. If a plan counted as completion, the review would be routed back to that agent with
    // reassign/decompose forbidden and the continuation hold released — an unrecoverable stall.
    it("still reports a manager-owned stall when the only artifact is a planning document", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      await insertPlanningDocument({ companyId: seeded.companyId, issueId: seeded.issueId });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.title).toBe("Review productivity for AUR-1370");
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).not.toContain("Classification: `unreported_completion`");
      // The document is still reported — as progress, explicitly not as completion evidence.
      expect(review?.description).toContain("Completed artifacts since `in_progress`: none");
      expect(review?.description).toContain("issue_document");
      expect(review?.description).toContain("started is not finished");
      expect(review?.description).toContain("Manager Decision");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_created"));
      expect((activity?.details as Record<string, unknown>)?.classification).toBe("stall");
      expect((activity?.details as Record<string, unknown>)?.workTraceArtifactCount).toBe(1);
      expect((activity?.details as Record<string, unknown>)?.workTraceCompletionArtifactCount).toBe(0);
    });

    // A draft work product is the same shape of false positive as the planning document.
    it("still reports a stall when the only work product is still a draft", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "document",
        provider: "paperclip",
        title: "Pricelist import notes",
        status: "draft",
        createdAt: new Date("2026-07-26T06:00:00.000Z"),
        updatedAt: new Date("2026-07-26T06:00:00.000Z"),
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });

    // The other direction: a non-code deliverable that the assignee itself declared finished is
    // completion evidence even without a commit, so it must not be rebuilt by a reassign.
    it("counts a work product handed to review as completion evidence", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      // A planning document from the same episode must not dilute the completion evidence.
      await insertPlanningDocument({ companyId: seeded.companyId, issueId: seeded.issueId });
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "document",
        provider: "paperclip",
        title: "Pricelist migration report",
        status: "ready_for_review",
        createdAt: new Date("2026-07-26T07:31:26.000Z"),
        updatedAt: new Date("2026-07-26T07:31:26.000Z"),
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.title).toBe("Report and close finished work on AUR-1370");
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).toContain("document (ready_for_review): Pricelist migration report");
      expect(review?.assigneeAgentId).toBe(seeded.coderId);

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_created"));
      expect((activity?.details as Record<string, unknown>)?.workTraceCompletionArtifactCount).toBe(1);
    });

    // A product created in an earlier episode and only moved into a completion status during this
    // one is the same evidence as one created here — filtering on creation time alone hid the
    // transition and sent finished work back down the stall path.
    /** The audit row the work-product PATCH route writes; `changedKeys` is what the trace reads. */
    async function logWorkProductUpdate(input: {
      companyId: string;
      issueId: string;
      workProductId: string;
      changedKeys: string[];
      previousStatus?: string;
      status?: string;
      at: Date;
    }) {
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "agent",
        actorId: "test",
        action: "issue.work_product_updated",
        entityType: "issue",
        entityId: input.issueId,
        details: {
          workProductId: input.workProductId,
          changedKeys: [...input.changedKeys].sort(),
          ...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        createdAt: input.at,
      });
    }

    it("counts a work product created before in_progress but completed during it", async () => {
      const { seeded, now, startedAt } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      const transitionAt = new Date("2026-07-26T07:31:26.000Z");
      const [product] = await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        title: "Pricelist addon",
        status: "merged",
        createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: transitionAt,
      }).returning();
      await logWorkProductUpdate({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        workProductId: product!.id,
        changedKeys: ["status"],
        previousStatus: "active",
        status: "merged",
        at: transitionAt,
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).toContain("pull_request (merged): Pricelist addon");
      // Listed at the transition, not at the creation two days before the episode.
      expect(review?.description).toContain("2026-07-26T07:31:26.000Z");
      expect(review?.assigneeAgentId).toBe(seeded.coderId);
    });

    // The boundary of the rule above: a completion that happened entirely before this episode is
    // not evidence for it, or a long-merged product would permanently disarm stall recovery.
    it("ignores a work product that was already complete before in_progress", async () => {
      const { seeded, now, startedAt } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        title: "Work from a previous episode",
        status: "merged",
        createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Completed artifacts since `in_progress`: none");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });

    // `changedKeys` says *that* status changed, never what it changed into. Without the recorded
    // previous status, a refinement between two completion states on work finished long before the
    // episode would read as a completion inside it — stale evidence disarming stall recovery.
    it("ignores a status change between two completion states on pre-episode work", async () => {
      const { seeded, now, startedAt } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      const refinedAt = new Date("2026-07-26T09:00:00.000Z");
      const [product] = await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        title: "Approved in a previous episode",
        status: "approved",
        createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: refinedAt,
      }).returning();
      await logWorkProductUpdate({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        workProductId: product!.id,
        changedKeys: ["status"],
        // Already complete before the episode; this only refined which completion state it is in.
        previousStatus: "ready_for_review",
        status: "approved",
        at: refinedAt,
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Completed artifacts since `in_progress`: none");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });

    // Evidence can land after the review was written. Leaving the review as a manager-owned stall
    // would keep "reassign / decompose" pointed at work that now demonstrably exists.
    it("reclassifies an open stall review once completion evidence appears", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const service = (repoPath: string) =>
        productivityReviewService(db, { resolveAgentWorkspaceDir: () => repoPath });

      await service(emptyRepo).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [stallReview] = await listProductivityReviews(seeded.companyId);
      expect(stallReview?.title).toBe("Review productivity for AUR-1370");
      expect(stallReview?.assigneeAgentId).toBe(seeded.managerId);

      // The finished run's commit surfaces on a later reconcile pass.
      const { repoPath, sha } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed after the stall review was written",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      await service(repoPath).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      const reviews = await listProductivityReviews(seeded.companyId);
      // Rewritten in place, not duplicated.
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review?.id).toBe(stallReview?.id);
      expect(review?.title).toBe("Report and close finished work on AUR-1370");
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).toContain(sha.slice(0, 7));
      expect(review?.description).toContain("Do **not** reassign, decompose, or restart");
      expect(review?.description).not.toContain("Manager Decision");
      // Ownership moves from the manager to the assignee, whose only loose end is the report.
      expect(review?.assigneeAgentId).toBe(seeded.coderId);

      // Intent before the review is touched, confirmation after the wake — the pair is what makes
      // a crash in between recoverable.
      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_updated"));
      expect(activity).toHaveLength(2);
      expect(activity.map((row) => (row.details as Record<string, unknown>)?.wakeDelivered).sort())
        .toEqual([false, true]);
      const confirmed = activity
        .find((row) => (row.details as Record<string, unknown>)?.wakeDelivered === true)
        ?.details as Record<string, unknown>;
      expect(confirmed?.reclassifiedFrom).toBe("stall");
      expect(confirmed?.previousAssigneeAgentId).toBe(seeded.managerId);
    });

    // The wake is about the instruction changing, not about ownership moving. A review that was
    // already assigned to the source assignee has no other trigger to act on the new instruction.
    it("wakes the assignee on reclassification even when ownership does not change", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const wakes: Array<{ agentId: string; classification: unknown }> = [];
      const service = (repoPath: string) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => repoPath,
          enqueueWakeup: async (agentId, wakeOpts) => {
            wakes.push({
              agentId,
              classification: (wakeOpts?.payload as Record<string, unknown> | undefined)?.classification,
            });
            return { id: "wake" };
          },
        });

      await service(emptyRepo).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [stallReview] = await listProductivityReviews(seeded.companyId);
      // Put the review in the shape the guard used to skip: already owned by the source assignee.
      await db.update(issues).set({ assigneeAgentId: seeded.coderId }).where(eq(issues.id, stallReview!.id));
      wakes.length = 0;

      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      await service(repoPath).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(wakes).toEqual([{ agentId: seeded.coderId, classification: "unreported_completion" }]);
    });

    // A reclassification is only finished once the assignee has been told. If the wake fails after
    // the review already reads as `unreported_completion`, the retry condition can never fire
    // again and the finished work sits assigned to an agent nobody triggers.
    it("retries the reclassification on a later pass when the wake fails", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const service = (dir: string, enqueueWakeup: (agentId: string, o?: unknown) => Promise<unknown>) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => dir,
          enqueueWakeup: enqueueWakeup as never,
        });

      await service(emptyRepo, async () => ({ id: "wake" })).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });
      const [stallReview] = await listProductivityReviews(seeded.companyId);
      expect(stallReview?.assigneeAgentId).toBe(seeded.managerId);

      // Pass 2: evidence exists, but the wake cannot be delivered.
      await service(repoPath, async () => {
        throw new Error("wake queue unavailable");
      }).reconcileProductivityReviews({ now: new Date(now.getTime() + 60_000), companyId: seeded.companyId });

      const [afterFailure] = await listProductivityReviews(seeded.companyId);
      // Restored, so the next pass still sees a stall to reclassify.
      expect(afterFailure?.title).toBe("Review productivity for AUR-1370");
      expect(afterFailure?.description).toContain("Classification: `stall`");
      expect(afterFailure?.assigneeAgentId).toBe(seeded.managerId);

      // Restoring the fields is not enough on its own. The reclassification comment and the
      // `reclassifiedFrom: "stall"` activity were already written and are history — they stay. What
      // must not happen is that they stand alone: a reader arriving at a review whose body says
      // `stall` would otherwise find a comment instructing them to report and close, and a recorded
      // transition that never survived. Both are answered by a compensating record, not by a delete.
      const failureComments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, stallReview!.id));
      const bodies = failureComments.map((row) => row.body);
      expect(bodies.some((body) => body.includes("Reclassified from `stall` to `unreported_completion`"))).toBe(true);
      expect(bodies.some((body) => body.includes("Rolled back to `stall`"))).toBe(true);
      expect(bodies.some((body) => body.includes("the assignee could not be woken"))).toBe(true);

      const failureActivity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_updated"));
      const rolledBack = failureActivity.filter(
        (row) => (row.details as Record<string, unknown> | null)?.rolledBackFrom === "unreported_completion",
      );
      expect(rolledBack).toHaveLength(1);
      expect((rolledBack[0]?.details as Record<string, unknown>)?.classification).toBe("stall");
      expect((rolledBack[0]?.details as Record<string, unknown>)?.reason).toBe("assignee_wake_failed");
      // The forward transition is still on record — appended to, never rewritten.
      expect(
        failureActivity.some(
          (row) => (row.details as Record<string, unknown> | null)?.reclassifiedFrom === "stall",
        ),
      ).toBe(true);

      // Pass 3: the wake works, and the reclassification lands.
      const wakes: string[] = [];
      await service(repoPath, async (agentId) => {
        wakes.push(agentId);
        return { id: "wake" };
      }).reconcileProductivityReviews({ now: new Date(now.getTime() + 120_000), companyId: seeded.companyId });

      const [afterRetry] = await listProductivityReviews(seeded.companyId);
      expect(afterRetry?.id).toBe(stallReview?.id);
      expect(afterRetry?.title).toBe("Report and close finished work on AUR-1370");
      expect(afterRetry?.description).toContain("Classification: `unreported_completion`");
      expect(afterRetry?.assigneeAgentId).toBe(seeded.coderId);
      expect(wakes).toEqual([seeded.coderId]);
    });

    // The stored idempotency key is not enforced by the enqueue path, so the resume looks the wake
    // row up itself. Without that, a crash after a successful wake would queue a second one.
    it("does not re-enqueue when the interrupted attempt's wake already landed", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const wakes: string[] = [];
      const service = (dir: string) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => dir,
          enqueueWakeup: (async (agentId: string) => {
            wakes.push(agentId);
            return { id: "wake" };
          }) as never,
        });

      await service(emptyRepo).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [review] = await listProductivityReviews(seeded.companyId);

      // The crash state, but this time the wake had already been created before the process died.
      await db.update(issues).set({
        title: "Report and close finished work on AUR-1370",
        description: "- Classification: `unreported_completion`",
        assigneeAgentId: seeded.coderId,
      }).where(eq(issues.id, review!.id));
      await db.insert(activityLog).values({
        companyId: seeded.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: review!.id,
        details: { reclassifiedFrom: "stall", reclassificationId: "cycle-9", wakeDelivered: false },
      });
      await db.insert(agentWakeupRequests).values({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        source: "assignment",
        idempotencyKey: "productivity-review-reclassify:cycle-9",
      });
      wakes.length = 0;

      await service(repoPath).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      expect(wakes).toEqual([]);
      // The cycle is still closed out, so it stops being retried.
      const markers = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_updated"));
      expect(markers.some((row) => (row.details as Record<string, unknown>)?.wakeDelivered === true)).toBe(true);
    });

    // A wake can be persisted and then dropped. Reading the row's existence as proof of delivery
    // would close the recovery cycle on a wake that never produced a run.
    it("re-wakes when the recorded wake was skipped rather than delivered", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const wakes: string[] = [];
      const service = (dir: string) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => dir,
          enqueueWakeup: (async (agentId: string) => {
            wakes.push(agentId);
            return { id: "wake" };
          }) as never,
        });

      await service(emptyRepo).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [review] = await listProductivityReviews(seeded.companyId);
      await db.update(issues).set({
        title: "Report and close finished work on AUR-1370",
        description: "- Classification: `unreported_completion`",
        assigneeAgentId: seeded.coderId,
      }).where(eq(issues.id, review!.id));
      await db.insert(activityLog).values({
        companyId: seeded.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: review!.id,
        details: { reclassifiedFrom: "stall", reclassificationId: "cycle-7", wakeDelivered: false },
      });
      await db.insert(agentWakeupRequests).values({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        source: "assignment",
        status: "skipped",
        idempotencyKey: "productivity-review-reclassify:cycle-7",
      });
      wakes.length = 0;

      await service(repoPath).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      expect(wakes).toEqual([seeded.coderId]);
    });

    // Confirming delivery with no owner would record a wake that never happened and close the retry
    // path for good, leaving finished work under an instruction nobody was given.
    it("rolls back rather than confirming a reclassification with no invokable owner", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      await productivityReviewService(db, { resolveAgentWorkspaceDir: () => emptyRepo })
        .reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [stallReview] = await listProductivityReviews(seeded.companyId);
      expect(stallReview?.description).toContain("Classification: `stall`");

      // No owner can be resolved: every candidate is gone.
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, stallReview!.id));
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.companyId, seeded.companyId));

      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      await productivityReviewService(db, { resolveAgentWorkspaceDir: () => repoPath })
        .reconcileProductivityReviews({ now: new Date(now.getTime() + 60_000), companyId: seeded.companyId });

      const [after] = await listProductivityReviews(seeded.companyId);
      expect(after?.title).toBe("Review productivity for AUR-1370");
      expect(after?.description).toContain("Classification: `stall`");
      const markers = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_updated"));
      expect(markers.every((row) => (row.details as Record<string, unknown>)?.wakeDelivered !== true)).toBe(true);
    });

    // A review created straight as an unreported completion has the same exposure as a
    // reclassified one: nothing tells a later pass that its wake never landed.
    it("re-wakes a newly created completion review whose first wake failed", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const wakes: string[] = [];
      const service = (enqueueWakeup: (agentId: string) => Promise<unknown>) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => repoPath,
          enqueueWakeup: enqueueWakeup as never,
        });

      // Pass 1: the review is created as an unreported completion, but the wake never lands.
      await service(async () => null).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [created] = await listProductivityReviews(seeded.companyId);
      expect(created?.title).toBe("Report and close finished work on AUR-1370");
      expect(created?.assigneeAgentId).toBe(seeded.coderId);

      // Pass 2: the outstanding marker makes the missed wake recoverable.
      await service(async (agentId) => {
        wakes.push(agentId);
        return { id: "wake" };
      }).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      expect(wakes).toEqual([seeded.coderId]);
      const reviews = await listProductivityReviews(seeded.companyId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.description).toContain("Classification: `unreported_completion`");
    });

    // A crash between the review update and the wake cannot be caught, so it has to be recoverable:
    // the review already reads `unreported_completion`, and the stall check alone would never retry.
    it("re-wakes a reclassification whose wake was never confirmed", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const emptyRepo = createEmptyRepoPath();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(aur1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const wakes: Array<{ agentId: string; idempotencyKey: unknown }> = [];
      const service = (dir: string) =>
        productivityReviewService(db, {
          resolveAgentWorkspaceDir: () => dir,
          enqueueWakeup: (async (agentId: string, wakeOpts?: { idempotencyKey?: unknown }) => {
            wakes.push({ agentId, idempotencyKey: wakeOpts?.idempotencyKey });
            return { id: "wake" };
          }) as never,
        });

      await service(emptyRepo).reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [review] = await listProductivityReviews(seeded.companyId);

      // Exactly the state a crash leaves behind: the review reclassified, the intent recorded, no
      // confirmation, and no wake ever delivered.
      await db.update(issues).set({
        title: "Report and close finished work on AUR-1370",
        description: "- Classification: `unreported_completion`",
        assigneeAgentId: seeded.coderId,
      }).where(eq(issues.id, review!.id));
      await db.insert(activityLog).values({
        companyId: seeded.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: review!.id,
        details: { reclassifiedFrom: "stall", reclassificationId: "cycle-1", wakeDelivered: false },
      });
      wakes.length = 0;

      await service(repoPath).reconcileProductivityReviews({
        now: new Date(now.getTime() + 60_000),
        companyId: seeded.companyId,
      });

      // The resumed cycle reuses the interrupted attempt's id, so a wake that already landed before
      // the crash is deduplicated instead of producing a second report-and-close run.
      expect(wakes).toEqual([
        { agentId: seeded.coderId, idempotencyKey: "productivity-review-reclassify:cycle-1" },
      ]);
      const [recovered] = await listProductivityReviews(seeded.companyId);
      expect(recovered?.description).toContain("Classification: `unreported_completion`");
      expect(recovered?.assigneeAgentId).toBe(seeded.coderId);
    });

    // The transition lookup must not be capped: with a bounded "newest N status changes" list, a
    // busy issue would push the one relevant transition out and produce the same false stall.
    it("keeps a completion transition that is older than many later status changes", async () => {
      const { seeded, now, startedAt } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      const transitionAt = new Date("2026-07-26T06:00:00.000Z");
      const [product] = await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        title: "Pricelist addon",
        status: "merged",
        createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: transitionAt,
      }).returning();
      await logWorkProductUpdate({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        workProductId: product!.id,
        changedKeys: ["status"],
        previousStatus: "active",
        status: "merged",
        at: transitionAt,
      });
      // 40 later status changes on other products of the same issue — comfortably more than any
      // reasonable cap on a "newest N events" lookup.
      for (let index = 0; index < 40; index += 1) {
        await logWorkProductUpdate({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          workProductId: randomUUID(),
          changedKeys: ["status"],
          previousStatus: "active",
          status: "merged",
          at: new Date(transitionAt.getTime() + (index + 1) * 60_000),
        });
      }

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).toContain("pull_request (merged): Pricelist addon");
      expect(review?.assigneeAgentId).toBe(seeded.coderId);
    });

    // The reason the membership test reads the recorded `changedKeys` instead of `updatedAt`:
    // a title fix on a long-merged product bumps `updatedAt` exactly like a completion would, and
    // treating that as fresh evidence would disarm stall recovery for a genuinely stuck agent.
    it("ignores a completed work product that was only edited, not re-completed, during the episode", async () => {
      const { seeded, now, startedAt } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      const editedAt = new Date("2026-07-26T09:00:00.000Z");
      const [product] = await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        title: "Merged in a previous episode",
        status: "merged",
        createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000),
        // Touched inside the episode — but by a title correction, not by a status change.
        updatedAt: editedAt,
      }).returning();
      await logWorkProductUpdate({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        workProductId: product!.id,
        changedKeys: ["title"],
        at: editedAt,
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Completed artifacts since `in_progress`: none");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });

    // The artifact list is capped in SQL. If the cap were applied by creation date alone, a burst
    // of newer drafts would push the one completed product out of the result set and the finished
    // work would be routed through the manager-owned stall path again.
    it("keeps completion evidence that is older than a full page of in-flight artifacts", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const repoPath = createEmptyRepoPath();
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "document",
        provider: "paperclip",
        title: "Pricelist migration report",
        status: "ready_for_review",
        createdAt: new Date("2026-07-26T06:00:00.000Z"),
        updatedAt: new Date("2026-07-26T06:00:00.000Z"),
      });
      // WORK_TRACE_MAX_ARTIFACTS newer drafts, i.e. exactly enough to fill the cap on their own.
      await db.insert(issueWorkProducts).values(
        Array.from({ length: 5 }, (_unused, index) => ({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          type: "document",
          provider: "paperclip",
          title: `Scratch note ${index + 1}`,
          status: "draft",
          createdAt: new Date(Date.UTC(2026, 6, 26, 8 + index, 0, 0)),
          updatedAt: new Date(Date.UTC(2026, 6, 26, 8 + index, 0, 0)),
        })),
      );

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `unreported_completion`");
      expect(review?.description).toContain("document (ready_for_review): Pricelist migration report");
      expect(review?.assigneeAgentId).toBe(seeded.coderId);
    });

    // Greptile P1 on #10348: the suffix was bounded, the prefix was not, so a neighbouring
    // project's key ending in the reviewed key read as evidence.
    it("still reports a stall when a longer identifier merely ends in the issue key", async () => {
      const { seeded, now } = await seedUnreportedCompletionCase();
      const { repoPath } = createRepoWithCommit({
        subject: "feat(BAUR-1370): neighbouring project key, not this issue",
        committedAt: "2026-07-26T07:31:26+02:00",
      });

      await productivityReviewService(db, {
        resolveAgentWorkspaceDir: () => repoPath,
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Classification: `stall`");
      expect(review?.description).toContain("Commits carrying the issue key: none");
      expect(review?.assigneeAgentId).toBe(seeded.managerId);
    });

    it("does not hold the assignee's continuation when the work already exists", async () => {
      const startedAt = new Date("2026-07-26T05:15:08.507Z");
      const now = new Date("2026-07-28T01:05:46.933Z");
      const seeded = await seedAssignedIssue({
        issuePrefix: "AUR",
        issueNumber: 1370,
        createdAt: new Date("2026-07-26T05:15:08.293Z"),
        startedAt,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
      const { repoPath } = createRepoWithCommit({
        subject: "feat(AUR-1370): deliverable landed",
        committedAt: "2026-07-26T07:31:26+02:00",
      });
      const service = productivityReviewService(db, { resolveAgentWorkspaceDir: () => repoPath });
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const hold = await service.isProductivityReviewContinuationHoldActive({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        agentId: seeded.coderId,
        now,
      });

      expect(hold.held).toBe(false);
    });

    it("matches compact and dashed issue keys, bounded on both sides", () => {
      const pattern = buildCommitGrepPattern("AUR-1370");
      expect(pattern).toBe("(^|[^0-9A-Za-z])AUR[-_ ]?1370([^0-9]|$)");
      const regex = new RegExp(pattern!, "i");
      expect(regex.test("feat(aur1370): addon")).toBe(true);
      expect(regex.test("fix AUR-1370 rollout")).toBe(true);
      expect(regex.test("fix AUR 1370 rollout")).toBe(true);
      expect(regex.test("AUR-1370 at the very start")).toBe(true);
      expect(regex.test("subject\nAUR-1370 in the body")).toBe(true);
      // Suffix boundary: a longer number is a different issue.
      expect(regex.test("fix AUR-13700 rollout")).toBe(false);
      expect(regex.test("fix AUR-1371 rollout")).toBe(false);
      // Prefix boundary: a longer identifier ending in the key is a different issue.
      expect(regex.test("fix BAUR-1370 rollout")).toBe(false);
      expect(regex.test("fix XAUR1370 rollout")).toBe(false);
      expect(regex.test("fix 9AUR-1370 rollout")).toBe(false);
      expect(buildCommitGrepPattern("not an identifier")).toBeNull();
      expect(buildCommitGrepPattern(null)).toBeNull();
    });
  });
});
