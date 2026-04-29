import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { IssueExternalGate } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

function makeGithubReviewGate(overrides: Partial<IssueExternalGate> = {}): IssueExternalGate {
  return {
    kind: "github_pr",
    status: "pending",
    requiredSignal: "github_non_author_approval",
    resolution: null,
    githubPr: {
      provider: "github",
      repoOwner: "Symphony-OS",
      repoName: "symphony-ai-edition",
      prNumber: 247,
      prUrl: "https://github.com/Symphony-OS/symphony-ai-edition/pull/247",
      headSha: "9db7ebf32712ed71b316669c7339d8dbca4c0031",
      isDraft: false,
      mergeable: true,
      mergeStateStatus: "CLEAN",
      checksStatus: "passing",
      requiredChecks: ["Vercel", "Vercel Preview Comments"],
      passedChecks: ["Vercel", "Vercel Preview Comments"],
      failedChecks: [],
      pendingChecks: [],
      reviewDecision: null,
      requiredReview: "non_author",
      nonAuthorApprovalSatisfied: false,
      visibleReviews: [
        {
          authorLogin: "gemini-code-assist",
          state: "COMMENTED",
          submittedAt: "2026-04-29T10:16:34.033Z",
          commitOid: "76079151260cdd34b7588ebb9c4a8140642afc41",
        },
        {
          authorLogin: "MeghV",
          state: "COMMENTED",
          submittedAt: "2026-04-29T14:51:52.000Z",
          commitOid: "9db7ebf32712ed71b316669c7339d8dbca4c0031",
        },
      ],
      unresolvedReviewThreads: 0,
      previewProtectionStatus: "protected",
      previewSmokeStatus: "unknown",
      currentViewerLogin: "MeghV",
      prAuthorLogin: "MeghV",
      currentViewerCanSatisfyReview: false,
    },
    ...overrides,
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue external gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService external gates", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-gates-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects marking an issue done while its external gate is still pending", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wait for formal approval",
      status: "blocked",
      priority: "medium",
      blockedReasonCode: "waiting_github_review",
      externalGate: makeGithubReviewGate(),
    });

    await expect(
      svc.update(issueId, { status: "done" }),
    ).rejects.toMatchObject({
      status: 422,
    });
  });

  it("keeps a done blocker unresolved until its declared external gate is satisfied", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Review blocker",
        status: "done",
        priority: "medium",
        externalGate: makeGithubReviewGate(),
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      allBlockersDone: false,
      isDependencyReady: false,
    });
    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([]);

    await svc.update(blockerId, {
      externalGate: makeGithubReviewGate({
        status: "accepted_exception",
        requiredSignal: "accepted_exception",
        resolution: {
          signal: "accepted_exception",
          capturedAt: "2026-04-29T15:57:22.423Z",
          note: "Megh intentionally merged PR #247 without a visible non-author approval.",
        },
        githubPr: {
          ...makeGithubReviewGate().githubPr!,
          nonAuthorApprovalSatisfied: false,
        },
      }),
    });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: blockedId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
  });

  it("fails closed when a persisted non-null external gate payload is malformed", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Malformed review blocker",
        status: "done",
        priority: "medium",
        externalGate: {
          kind: "github_pr",
          status: "pending",
        } as unknown as IssueExternalGate,
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      allBlockersDone: false,
      isDependencyReady: false,
    });
    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([]);
  });

  it("auto-classifies preview and credential gates into the blocked-reason taxonomy", async () => {
    const companyId = randomUUID();
    const previewIssueId = randomUUID();
    const credentialIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: previewIssueId,
        companyId,
        title: "Preview bypass blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: credentialIssueId,
        companyId,
        title: "Credential blocker",
        status: "todo",
        priority: "medium",
      },
    ]);

    const previewIssue = await svc.update(previewIssueId, {
      status: "blocked",
      externalGate: {
        kind: "preview_access",
        status: "pending",
        requiredSignal: "preview_bypass_ready",
        resolution: null,
        githubPr: null,
      },
    });
    const credentialIssue = await svc.update(credentialIssueId, {
      status: "blocked",
      externalGate: {
        kind: "test_credentials",
        status: "pending",
        requiredSignal: "test_credentials_received",
        resolution: null,
        githubPr: null,
      },
    });

    expect(previewIssue?.blockedReasonCode).toBe("waiting_preview_bypass");
    expect(credentialIssue?.blockedReasonCode).toBe("waiting_test_credentials");
  });
});
