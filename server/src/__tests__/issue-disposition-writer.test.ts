import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  buildIssueDispositionIdempotencyKey,
  type IssueCommentMetadata,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DISPOSITION_ERROR_CODES,
  issueDispositionService,
} from "../services/issue-disposition.ts";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres disposition writer tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface SeedRefs {
  companyId: string;
  workerAgentId: string;
  reviewerAgentId: string;
  issueId: string;
  workerRunId: string;
  reviewerRunId: string;
}

function buildMetadataWithDispositionRow(refs: { issueId: string; runId: string }, options?: {
  value?:
    | "done"
    | "blocked"
    | "needs_review"
    | "needs_qa"
    | "needs_approval"
    | "needs_fix"
    | "duplicate"
    | "superseded"
    | "not_actionable";
  reason?: string;
  evidenceRefs?: IssueCommentMetadata["sections"][number]["rows"][number] extends { evidenceRefs: infer R } ? R : never;
}): IssueCommentMetadata {
  const value = options?.value ?? "done";
  const idempotencyKey = buildIssueDispositionIdempotencyKey({
    issueId: refs.issueId,
    sourceRunId: refs.runId,
    dispositionValue: value,
  });
  return {
    version: 1,
    sourceRunId: refs.runId,
    sections: [
      {
        title: "Disposition",
        rows: [
          {
            type: "disposition",
            value,
            reason: options?.reason ?? "All acceptance criteria met",
            evidenceRefs: options?.evidenceRefs ?? [],
            idempotencyKey,
          },
        ],
      },
    ],
  };
}

describeEmbeddedPostgres("issue disposition writer (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-disposition-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<SeedRefs> {
    const companyId = randomUUID();
    const workerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const workerRunId = randomUUID();
    const reviewerRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerAgentId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "reviewer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement disposition writer",
      status: "in_progress",
      assigneeAgentId: workerAgentId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: workerRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        status: "running",
      },
      {
        id: reviewerRunId,
        companyId,
        agentId: reviewerAgentId,
        invocationSource: "assignment",
        status: "running",
      },
    ]);
    return { companyId, workerAgentId, reviewerAgentId, issueId, workerRunId, reviewerRunId };
  }

  it("rejects done from a worker actor with no distinct reviewer or approved decisions (vacuous review path stays true but transition still applies)", async () => {
    // With no stages and no decisions, hasApprovedReview/Approval flags are
    // vacuously true. Worker self-attest skips when no stage exists. So this
    // path should *apply* — covering the happy zero-policy case.
    const seeded = await seed();
    const svc = issueDispositionService(db);

    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    const result = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(result.applied).toBe(true);
    expect(result.dispositionValue).toBe("done");
    expect(result.evidence.nextStatus).toBe("done");

    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();
  });

  it("is idempotent for the same body+metadata posted twice (no duplicate comment, no status churn)", async () => {
    const seeded = await seed();
    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });

    const first = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(first.applied).toBe(true);

    const second = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(second.applied).toBe(false);
    expect(second.noop).toBe(true);
    expect(second.comment.id).toBe(first.comment.id);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
  });

  it("rejects same idempotency key with a different body as a conflict", async () => {
    const seeded = await seed();
    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });

    await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });

    await expect(
      svc.applyCommentDisposition({
        issueId: seeded.issueId,
        body: "Marking done — different body",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_CONFLICT },
    });
  });

  it("allows distinct idempotency keys (different sourceRunId) without collision", async () => {
    const seeded = await seed();
    const svc = issueDispositionService(db);
    const firstKeyMetadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: seeded.companyId,
      agentId: seeded.workerAgentId,
      invocationSource: "assignment",
      status: "running",
    });
    const secondKeyMetadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: otherRunId });

    const first = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "first done",
      authorType: "agent",
      metadata: firstKeyMetadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(first.applied).toBe(true);

    // Issue is now done; second key with the same disposition still applies (idempotent for that key)
    // and creates a separate comment because the keys differ. Status stays done.
    const second = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "second done",
      authorType: "agent",
      metadata: secondKeyMetadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: otherRunId },
    });
    expect(second.applied).toBe(true);
    expect(second.comment.id).not.toBe(first.comment.id);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(2);
  });

  it("rejects when sourceRunId references a heartbeat run owned by another company", async () => {
    const seeded = await seed();
    // Create a separate company's heartbeat run
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: otherCompanyId,
      agentId: otherAgentId,
      invocationSource: "assignment",
      status: "running",
    });

    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: otherRunId });
    await expect(
      svc.applyCommentDisposition({
        issueId: seeded.issueId,
        body: "Marking done",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: otherRunId },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.SOURCE_RUN_FOREIGN_COMPANY },
    });
  });

  it("rejects worker self-attest of done when a review stage exists with only the worker's own approved decision", async () => {
    const seeded = await seed();
    // Install execution policy with one review stage owned by the worker
    const stageId = randomUUID();
    await db
      .update(issues)
      .set({
        executionPolicy: {
          mode: "normal",
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [
                { id: randomUUID(), type: "agent", agentId: seeded.workerAgentId, userId: null },
              ],
            },
          ],
        },
      })
      .where(eq(issues.id, seeded.issueId));
    await db.insert(issueExecutionDecisions).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      stageId,
      stageType: "review",
      actorAgentId: seeded.workerAgentId,
      outcome: "approved",
      body: "self-approving",
    });

    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    await expect(
      svc.applyCommentDisposition({
        issueId: seeded.issueId,
        body: "Marking done",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.WORKER_SELF_ATTEST },
    });
  });

  it("accepts done when a distinct reviewer has an approved review decision", async () => {
    const seeded = await seed();
    const stageId = randomUUID();
    await db
      .update(issues)
      .set({
        executionPolicy: {
          mode: "normal",
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [
                { id: randomUUID(), type: "agent", agentId: seeded.reviewerAgentId, userId: null },
              ],
            },
          ],
        },
      })
      .where(eq(issues.id, seeded.issueId));
    await db.insert(issueExecutionDecisions).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      stageId,
      stageType: "review",
      actorAgentId: seeded.reviewerAgentId,
      outcome: "approved",
      body: "looks good",
    });

    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    const result = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(result.applied).toBe(true);

    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("done");
  });

  it("rejects done when a review stage exists without any approved review decision", async () => {
    const seeded = await seed();
    const stageId = randomUUID();
    await db
      .update(issues)
      .set({
        executionPolicy: {
          mode: "normal",
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [
                { id: randomUUID(), type: "agent", agentId: seeded.reviewerAgentId, userId: null },
              ],
            },
          ],
        },
      })
      .where(eq(issues.id, seeded.issueId));

    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    await expect(
      svc.applyCommentDisposition({
        issueId: seeded.issueId,
        body: "Marking done",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
      }),
    ).rejects.toMatchObject({
      details: {
        code: DISPOSITION_ERROR_CODES.INVALID_TRANSITION,
        missing: "approved_review_decisions",
      },
    });
  });

  it("removes this issue as a blocker on done (parent blocker linkage cleared per transition intention)", async () => {
    const seeded = await seed();
    const dependentIssueId = randomUUID();
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId: seeded.companyId,
      title: "Dependent task",
      status: "blocked",
    });
    await db.insert(issueRelations).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    const svc = issueDispositionService(db);
    const metadata = buildMetadataWithDispositionRow({ issueId: seeded.issueId, runId: seeded.workerRunId });
    const result = await svc.applyCommentDisposition({
      issueId: seeded.issueId,
      body: "Marking done",
      authorType: "agent",
      metadata,
      actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
    });
    expect(result.applied).toBe(true);

    const remainingRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, seeded.companyId),
          eq(issueRelations.issueId, seeded.issueId),
        ),
      );
    expect(remainingRelations).toHaveLength(0);
  });

  it("rejects an idempotency key whose embedded issueId does not match the target issue", async () => {
    const seeded = await seed();
    const svc = issueDispositionService(db);
    const wrongIssueKey = buildIssueDispositionIdempotencyKey({
      issueId: randomUUID(),
      sourceRunId: seeded.workerRunId,
      dispositionValue: "done",
    });
    const metadata: IssueCommentMetadata = {
      version: 1,
      sourceRunId: seeded.workerRunId,
      sections: [
        {
          rows: [
            {
              type: "disposition",
              value: "done",
              reason: "x",
              evidenceRefs: [],
              idempotencyKey: wrongIssueKey,
            },
          ],
        },
      ],
    };

    await expect(
      svc.applyCommentDisposition({
        issueId: seeded.issueId,
        body: "wrong key",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: seeded.workerAgentId, runId: seeded.workerRunId },
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
