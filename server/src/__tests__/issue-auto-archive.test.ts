import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildIssueAutoArchiveService } from "../services/issue-auto-archive.js";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue-auto-archive service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase();
    db = createDb(tempDb.connectionString);

    const company = await db
      .insert(companies)
      .values({
        name: `AutoArchiveTest-${randomUUID()}`,
        issuePrefix: `AA${randomUUID().slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const project = await db
      .insert(projects)
      .values({ companyId, name: "Test Project" })
      .returning()
      .then((rows) => rows[0]!);
    projectId = project.id;
  });

  afterAll(async () => {
    await tempDb?.teardown();
  });

  async function insertIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    return db
      .insert(issues)
      .values({
        companyId,
        projectId,
        title: `Test Issue ${randomUUID()}`,
        status: "backlog",
        ...overrides,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function getIssueHiddenAt(id: string): Promise<Date | null | undefined> {
    return db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0]?.hiddenAt);
  }

  const NOW = new Date("2025-01-10T12:00:00Z");
  const TWO_DAYS_ONE_SECOND_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000 - 1000);
  const ONE_DAY_AGO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const THREE_DAYS_ONE_SECOND_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000 - 1000);

  describe("archiveCancelledIssues", () => {
    it("archives cancelled issues with cancelledAt older than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        status: "cancelled",
        cancelledAt: TWO_DAYS_ONE_SECOND_AGO,
        hiddenAt: null,
      });

      const count = await svc.archiveCancelledIssues(NOW);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await getIssueHiddenAt(issue.id)).not.toBeNull();
    });

    it("does not archive cancelled issues newer than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        status: "cancelled",
        cancelledAt: ONE_DAY_AGO,
        hiddenAt: null,
      });

      await svc.archiveCancelledIssues(NOW);
      expect(await getIssueHiddenAt(issue.id)).toBeNull();
    });

    it("skips already-hidden cancelled issues", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const alreadyHidden = new Date("2025-01-01T00:00:00Z");
      const issue = await insertIssue({
        status: "cancelled",
        cancelledAt: TWO_DAYS_ONE_SECOND_AGO,
        hiddenAt: alreadyHidden,
      });

      const count = await svc.archiveCancelledIssues(NOW);
      expect(count).toBe(0);
      expect((await getIssueHiddenAt(issue.id))?.toISOString()).toBe(alreadyHidden.toISOString());
    });
  });

  describe("archiveReviewIssues", () => {
    it("archives stale_active_run_evaluation issues older than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        originKind: RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
        createdAt: TWO_DAYS_ONE_SECOND_AGO,
        hiddenAt: null,
      });

      const count = await svc.archiveReviewIssues(NOW);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await getIssueHiddenAt(issue.id)).not.toBeNull();
    });

    it("archives issue_productivity_review issues older than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
        createdAt: TWO_DAYS_ONE_SECOND_AGO,
        hiddenAt: null,
      });

      const count = await svc.archiveReviewIssues(NOW);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await getIssueHiddenAt(issue.id)).not.toBeNull();
    });

    it("does not archive review issues newer than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        originKind: RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
        createdAt: ONE_DAY_AGO,
        hiddenAt: null,
      });

      await svc.archiveReviewIssues(NOW);
      expect(await getIssueHiddenAt(issue.id)).toBeNull();
    });

    it("does not archive non-review issues older than 2 days", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const issue = await insertIssue({
        originKind: "manual",
        status: "done",
        createdAt: TWO_DAYS_ONE_SECOND_AGO,
        hiddenAt: null,
      });

      await svc.archiveReviewIssues(NOW);
      expect(await getIssueHiddenAt(issue.id)).toBeNull();
    });
  });

  describe("archiveMergedBranchIssues", () => {
    it("archives issues whose git_worktree workspace was archived > 3 days ago", async () => {
      const svc = buildIssueAutoArchiveService(db as any);

      const workspace = await db
        .insert(executionWorkspaces)
        .values({
          companyId,
          projectId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: `ws-${randomUUID()}`,
          status: "archived",
          providerType: "git_worktree",
          closedAt: THREE_DAYS_ONE_SECOND_AGO,
        })
        .returning()
        .then((rows) => rows[0]!);

      const issue = await insertIssue({
        executionWorkspaceId: workspace.id,
        hiddenAt: null,
      });

      const count = await svc.archiveMergedBranchIssues(NOW);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await getIssueHiddenAt(issue.id)).not.toBeNull();
    });

    it("does not archive issues with a recently-closed workspace", async () => {
      const svc = buildIssueAutoArchiveService(db as any);

      const workspace = await db
        .insert(executionWorkspaces)
        .values({
          companyId,
          projectId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: `ws-${randomUUID()}`,
          status: "archived",
          providerType: "git_worktree",
          closedAt: ONE_DAY_AGO,
        })
        .returning()
        .then((rows) => rows[0]!);

      const issue = await insertIssue({
        executionWorkspaceId: workspace.id,
        hiddenAt: null,
      });

      await svc.archiveMergedBranchIssues(NOW);
      expect(await getIssueHiddenAt(issue.id)).toBeNull();
    });

    it("does not archive issues with non-git_worktree workspace", async () => {
      const svc = buildIssueAutoArchiveService(db as any);

      const workspace = await db
        .insert(executionWorkspaces)
        .values({
          companyId,
          projectId,
          mode: "shared_workspace",
          strategyType: "project_primary",
          name: `ws-${randomUUID()}`,
          status: "archived",
          providerType: "local_fs",
          closedAt: THREE_DAYS_ONE_SECOND_AGO,
        })
        .returning()
        .then((rows) => rows[0]!);

      const issue = await insertIssue({
        executionWorkspaceId: workspace.id,
        hiddenAt: null,
      });

      await svc.archiveMergedBranchIssues(NOW);
      expect(await getIssueHiddenAt(issue.id)).toBeNull();
    });
  });

  describe("tick", () => {
    it("returns a result with all counts summing to total", async () => {
      const svc = buildIssueAutoArchiveService(db as any);
      const result = await svc.tick(NOW);
      expect(result.total).toBe(
        result.cancelledArchived + result.reviewArchived + result.mergedBranchArchived,
      );
    });
  });
});
