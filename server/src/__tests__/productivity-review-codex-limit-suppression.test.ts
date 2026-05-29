/**
 * KSI-687 — Commit 3 tests: productivity-review D4 suppression for codex-limit
 *
 * Verifies that:
 * 1. An issue blocked with the `codex-limit` label does NOT trigger
 *    longActive-based productivity reviews (suppressed).
 * 2. A regular issue without the label still triggers productivity reviews
 *    (control case — the guard does not over-suppress).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { productivityReviewService } from "../services/productivity-review.ts";
import { CODEX_LIMIT_LABEL_NAME, issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity-review D4 suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivityReviewService: codex-limit suppression (KSI-687 D4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-d4-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed a minimal fixture: company + codex_local agent + in_progress issue
   * that has been active for more than DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS.
   * Returns ids needed for assertions.
   */
  async function seedLongActiveIssue(opts?: { withCodexLimitLabel?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const managerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `D4${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    // Issue started 8 hours ago (exceeds the default 6h threshold)
    const startedAt = new Date(Date.now() - 8 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip D4",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Manager (needed so issueService can assign review to a chain-of-command member)
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      reportsTo: managerId,
      permissions: {},
    });

    // Run before issue (FK)
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId },
      updatedAt: startedAt,
      createdAt: startedAt,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long-running issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: startedAt,
      startedAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    if (opts?.withCodexLimitLabel) {
      const issuesSvc = issueService(db);
      await issuesSvc.addCodexLimitLabelToIssue(issueId, companyId);
    }

    return { companyId, agentId, issueId, runId };
  }

  it("collectEvidence: issue with codex-limit label → longActive suppressed (no review triggered)", async () => {
    const { companyId } = await seedLongActiveIssue({ withCodexLimitLabel: true });
    const service = productivityReviewService(db);

    // reconcileProductivityReviews processes all in_progress issues
    await service.reconcileProductivityReviews();

    // No productivity review issue should have been created for this company
    const reviewIssues = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), sql`${issues.title} ilike '%productivity review%'`));

    expect(reviewIssues).toHaveLength(0);
  });

  it("collectEvidence: issue WITHOUT codex-limit label → longActive fires → review triggered (control)", async () => {
    const { companyId } = await seedLongActiveIssue({ withCodexLimitLabel: false });
    const service = productivityReviewService(db);

    await service.reconcileProductivityReviews();

    // A productivity review issue should have been created
    const reviewIssues = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), sql`${issues.title} ilike '%productivity%'`));

    expect(reviewIssues.length).toBeGreaterThan(0);
  });
});
