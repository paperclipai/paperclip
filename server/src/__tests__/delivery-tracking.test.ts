import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  deliveryAcceptances,
  deliverySubmissions,
  deliveryTracks,
  deliveryVerdicts,
  deliveryVerificationEvidence,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueDocuments,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import {
  deliveryTrackingService,
  type DeliveryActor,
  type DeliveryTrackingService,
} from "../services/delivery-tracking.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HEAD_SHA = "a".repeat(40);
const NEXT_HEAD_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const REPOSITORY_URL = "https://example.invalid/org/repo.git";

function denialCode(error: unknown) {
  if (!(error instanceof HttpError)) return null;
  const details = error.details;
  if (!details || typeof details !== "object" || !("code" in details)) return null;
  return typeof details.code === "string" ? details.code : null;
}

async function expectDenial(operation: Promise<unknown>, code: string) {
  let caught: unknown;
  await operation.catch((error: unknown) => {
    caught = error;
  });
  expect(caught, `expected ${code}`).toBeDefined();
  expect(denialCode(caught)).toBe(code);
  return caught;
}

describeEmbeddedPostgres("delivery tracking", () => {
  let db!: Db;
  let svc!: DeliveryTrackingService;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-tracking-");
    db = createDb(tempDb.connectionString);
    svc = deliveryTrackingService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(deliveryAcceptances);
    await db.delete(deliveryVerdicts);
    await db.delete(deliverySubmissions);
    await db.delete(deliveryVerificationEvidence);
    await db.delete(deliveryTracks);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Scenario = {
    companyId: string;
    issueId: string;
    writerAgentId: string;
    writerRunId: string;
    reviewerAgentId: string;
    reviewerRunId: string;
    writer: DeliveryActor;
    reviewer: DeliveryActor;
    board: DeliveryActor;
    planDocumentId: string;
    planRevisionId: string;
  };

  async function seed(): Promise<Scenario> {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const writerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const writerRunId = randomUUID();
    const reviewerRunId = randomUUID();
    const planDocumentId = randomUUID();
    const planRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    for (const [id, name] of [[writerAgentId, "Writer"], [reviewerAgentId, "Reviewer"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(heartbeatRuns).values([
      { id: writerRunId, companyId, agentId: writerAgentId, status: "running" },
      { id: reviewerRunId, companyId, agentId: reviewerAgentId, status: "running" },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the change",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      checkoutRunId: writerRunId,
      executionRunId: writerRunId,
    });
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: planRevisionId,
      latestRevisionNumber: 1,
      createdByAgentId: writerAgentId,
      updatedByAgentId: writerAgentId,
    });
    await db.insert(documentRevisions).values({
      id: planRevisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: writerAgentId,
    });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: planDocumentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId,
          documentId: planDocumentId,
          key: "plan",
          revisionId: planRevisionId,
          revisionNumber: 1,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
      createdByUserId: "local-board",
      resolvedByUserId: "local-board",
    });

    return {
      companyId,
      issueId,
      writerAgentId,
      writerRunId,
      reviewerAgentId,
      reviewerRunId,
      writer: { type: "agent", agentId: writerAgentId, runId: writerRunId },
      reviewer: { type: "agent", agentId: reviewerAgentId, runId: reviewerRunId },
      board: { type: "user", userId: "local-board", sessionId: null },
      planDocumentId,
      planRevisionId,
    };
  }

  async function enrollStrict(scenario: Scenario) {
    return svc.enroll(
      scenario.issueId,
      {
        repositoryUrl: REPOSITORY_URL,
        requireReview: true,
        requireVerifiedEvidence: true,
        pinPlanRevision: true,
        reviewerAgentIds: [scenario.reviewerAgentId],
      },
      scenario.board,
    );
  }

  async function registerEvidence(scenario: Scenario, headSha = HEAD_SHA, digest = "d".repeat(64)) {
    return svc.ingestEvidence(
      scenario.issueId,
      {
        planRevisionId: scenario.planRevisionId,
        candidateHeadSha: headSha,
        kind: "command_result",
        digest,
        summary: { label: "integration suite", command: "pnpm test:run", exitCode: 0 },
        producerLabel: "protected-runner",
      },
      scenario.board,
    );
  }

  async function driveToAcceptance(scenario: Scenario) {
    await enrollStrict(scenario);
    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );
    await svc.recordVerdict(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidateHeadSha: HEAD_SHA,
        verdict: "pass",
        findings: [],
      },
      scenario.reviewer,
    );
    const evidence = await registerEvidence(scenario);
    return svc.accept(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidateHeadSha: HEAD_SHA,
        verificationEvidenceRefs: [evidence.id],
      },
      scenario.board,
    );
  }

  it("leaves an unenrolled issue completely ungated", async () => {
    const scenario = await seed();

    const updated = await issueService(db).update(scenario.issueId, { status: "done" });

    expect(updated?.status).toBe("done");
    const snapshot = await svc.snapshot(scenario.issueId, scenario.writer);
    expect(snapshot.enrolled).toBe(false);
    expect(snapshot.allowedActions).toEqual(["enroll"]);
  }, 30_000);

  it("blocks completion of an enrolled issue until a candidate is accepted, then allows it", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);

    await expectDenial(
      issueService(db).update(scenario.issueId, { status: "done" }),
      "delivery_acceptance_missing",
    );
    expect(await db.select({ status: issues.status }).from(issues).where(eq(issues.id, scenario.issueId)))
      .toEqual([{ status: "in_progress" }]);

    await driveToAcceptance(scenario);
    const completed = await issueService(db).update(scenario.issueId, { status: "done" });

    expect(completed?.status).toBe("done");
  }, 30_000);

  it("still allows cancelling an enrolled issue so tracked work stays abandonable", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);

    const cancelled = await issueService(db).update(scenario.issueId, { status: "cancelled" });

    expect(cancelled?.status).toBe("cancelled");
  }, 30_000);

  it("rejects completion when the plan revision advances after acceptance", async () => {
    const scenario = await seed();
    await driveToAcceptance(scenario);

    const newerRevisionId = randomUUID();
    await db.insert(documentRevisions).values({
      id: newerRevisionId,
      companyId: scenario.companyId,
      documentId: scenario.planDocumentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "Plan body v2",
      createdByAgentId: scenario.writerAgentId,
    });
    await db
      .update(documents)
      .set({ latestRevisionId: newerRevisionId, latestRevisionNumber: 2, latestBody: "Plan body v2" })
      .where(eq(documents.id, scenario.planDocumentId));

    await expectDenial(issueService(db).update(scenario.issueId, { status: "done" }), "delivery_acceptance_stale");
  }, 30_000);

  it("rejects completion when a newer candidate is submitted after acceptance", async () => {
    const scenario = await seed();
    await driveToAcceptance(scenario);

    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: NEXT_HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );

    await expectDenial(issueService(db).update(scenario.issueId, { status: "done" }), "delivery_acceptance_stale");
  }, 30_000);

  it("refuses a submission from a run that does not hold the issue", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    const candidate = {
      expectedPlanRevisionId: scenario.planRevisionId,
      candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
    };

    await expectDenial(
      svc.submit(scenario.issueId, candidate, {
        type: "agent",
        agentId: scenario.writerAgentId,
        runId: randomUUID(),
      }),
      "delivery_actor_run_not_current",
    );
    await expectDenial(
      svc.submit(scenario.issueId, candidate, scenario.reviewer),
      "delivery_writer_not_current",
    );
    await expectDenial(
      svc.submit(scenario.issueId, candidate, {
        type: "agent",
        agentId: scenario.writerAgentId,
        runId: null,
      }),
      "delivery_actor_run_required",
    );

    expect(await db.select().from(deliverySubmissions)).toHaveLength(0);
  }, 30_000);

  it("treats a re-submitted identical candidate as the same submission", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    const candidate = {
      expectedPlanRevisionId: scenario.planRevisionId,
      candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
    };

    const first = await svc.submit(scenario.issueId, candidate, scenario.writer);
    const second = await svc.submit(scenario.issueId, candidate, scenario.writer);

    expect(second.id).toBe(first.id);
    expect(await db.select().from(deliverySubmissions)).toHaveLength(1);
  }, 30_000);

  it("rejects a stale expected plan revision on submit", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);

    await expectDenial(
      svc.submit(
        scenario.issueId,
        {
          expectedPlanRevisionId: randomUUID(),
          candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
        },
        scenario.writer,
      ),
      "delivery_plan_revision_mismatch",
    );
  }, 30_000);

  it("rejects a candidate from a repository the issue does not track", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);

    await expectDenial(
      svc.submit(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidate: {
            repositoryUrl: "https://example.invalid/org/other",
            headSha: HEAD_SHA,
            baseSha: BASE_SHA,
          },
        },
        scenario.writer,
      ),
      "delivery_repository_mismatch",
    );
  }, 30_000);

  it("refuses self-review and review by an agent that is not a configured reviewer", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );
    const verdict = {
      expectedPlanRevisionId: scenario.planRevisionId,
      candidateHeadSha: HEAD_SHA,
      verdict: "pass" as const,
      findings: [],
    };

    await expectDenial(
      svc.recordVerdict(scenario.issueId, verdict, scenario.writer),
      "delivery_reviewer_not_allowed",
    );

    const outsiderAgentId = randomUUID();
    const outsiderRunId = randomUUID();
    await db.insert(agents).values({
      id: outsiderAgentId,
      companyId: scenario.companyId,
      name: "Outsider",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: outsiderRunId,
      companyId: scenario.companyId,
      agentId: outsiderAgentId,
      status: "running",
    });

    await expectDenial(
      svc.recordVerdict(scenario.issueId, verdict, {
        type: "agent",
        agentId: outsiderAgentId,
        runId: outsiderRunId,
      }),
      "delivery_reviewer_not_allowed",
    );
    expect(await db.select().from(deliveryVerdicts)).toHaveLength(0);
  }, 30_000);

  it("refuses self-review when any agent may review", async () => {
    const scenario = await seed();
    await svc.enroll(
      scenario.issueId,
      {
        repositoryUrl: REPOSITORY_URL,
        requireReview: true,
        requireVerifiedEvidence: false,
        pinPlanRevision: false,
        reviewerAgentIds: [],
      },
      scenario.board,
    );
    await svc.submit(
      scenario.issueId,
      { candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA } },
      scenario.writer,
    );

    await expectDenial(
      svc.recordVerdict(
        scenario.issueId,
        { candidateHeadSha: HEAD_SHA, verdict: "pass", findings: [] },
        scenario.writer,
      ),
      "delivery_reviewer_not_independent",
    );
  }, 30_000);

  it("refuses acceptance and evidence registration from an agent identity", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );
    await svc.recordVerdict(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidateHeadSha: HEAD_SHA,
        verdict: "pass",
        findings: [],
      },
      scenario.reviewer,
    );

    await expectDenial(
      svc.ingestEvidence(
        scenario.issueId,
        {
          planRevisionId: scenario.planRevisionId,
          candidateHeadSha: HEAD_SHA,
          kind: "command_result",
          digest: "e".repeat(64),
          summary: { label: "self-reported pass" },
          producerLabel: "worker",
        },
        scenario.writer,
      ),
      "delivery_acceptance_actor_forbidden",
    );
    await expectDenial(
      svc.accept(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidateHeadSha: HEAD_SHA,
          verificationEvidenceRefs: [randomUUID()],
        },
        scenario.writer,
      ),
      "delivery_acceptance_actor_forbidden",
    );
    expect(await db.select().from(deliveryVerificationEvidence)).toHaveLength(0);
    expect(await db.select().from(deliveryAcceptances)).toHaveLength(0);
  }, 30_000);

  it("rejects acceptance whose evidence references are not registered evidence for the candidate", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );
    await svc.recordVerdict(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidateHeadSha: HEAD_SHA,
        verdict: "pass",
        findings: [],
      },
      scenario.reviewer,
    );
    // Evidence exists, but for a different candidate head.
    const otherCandidateEvidence = await registerEvidence(scenario, NEXT_HEAD_SHA, "f".repeat(64));

    await expectDenial(
      svc.accept(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidateHeadSha: HEAD_SHA,
          verificationEvidenceRefs: [otherCandidateEvidence.id],
        },
        scenario.board,
      ),
      "delivery_evidence_untrusted",
    );
    await expectDenial(
      svc.accept(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidateHeadSha: HEAD_SHA,
          verificationEvidenceRefs: [],
        },
        scenario.board,
      ),
      "delivery_evidence_missing",
    );
  }, 30_000);

  it("rejects acceptance while the current review asks for changes", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    await svc.submit(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
      },
      scenario.writer,
    );
    await svc.recordVerdict(
      scenario.issueId,
      {
        expectedPlanRevisionId: scenario.planRevisionId,
        candidateHeadSha: HEAD_SHA,
        verdict: "changes_requested",
        findings: [{ summary: "Missing regression coverage for the retry path" }],
      },
      scenario.reviewer,
    );
    const evidence = await registerEvidence(scenario);

    await expectDenial(
      svc.accept(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidateHeadSha: HEAD_SHA,
          verificationEvidenceRefs: [evidence.id],
        },
        scenario.board,
      ),
      "delivery_review_not_passed",
    );
  }, 30_000);

  it("keeps an agent from relaxing its own track requirements", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);

    await expectDenial(
      svc.enroll(
        scenario.issueId,
        {
          repositoryUrl: REPOSITORY_URL,
          requireReview: false,
          requireVerifiedEvidence: false,
          pinPlanRevision: false,
          reviewerAgentIds: [],
        },
        scenario.writer,
      ),
      "delivery_acceptance_actor_forbidden",
    );
    await expectDenial(svc.closeTrack(scenario.issueId, scenario.writer), "delivery_acceptance_actor_forbidden");

    const [track] = await db.select().from(deliveryTracks);
    expect(track).toMatchObject({ requireReview: true, requireVerifiedEvidence: true, status: "active" });
  }, 30_000);

  it("lets the holding agent enroll its own issue for candidate tracking", async () => {
    const scenario = await seed();

    const track = await svc.enroll(
      scenario.issueId,
      {
        repositoryUrl: REPOSITORY_URL,
        requireReview: false,
        requireVerifiedEvidence: false,
        pinPlanRevision: false,
        reviewerAgentIds: [],
      },
      scenario.writer,
    );

    expect(track).toMatchObject({ issueId: scenario.issueId, enrolledByAgentId: scenario.writerAgentId });
    const snapshot = await svc.snapshot(scenario.issueId, scenario.writer);
    expect(snapshot.enrolled).toBe(true);
    expect(snapshot.actorIsCurrentWriter).toBe(true);
    expect(snapshot.allowedActions).toContain("submit");
  }, 30_000);

  it("reports a stale accepted plan revision instead of an effective one", async () => {
    const scenario = await seed();
    await enrollStrict(scenario);
    const newerRevisionId = randomUUID();
    await db.insert(documentRevisions).values({
      id: newerRevisionId,
      companyId: scenario.companyId,
      documentId: scenario.planDocumentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "Plan body v2",
      createdByAgentId: scenario.writerAgentId,
    });
    await db
      .update(documents)
      .set({ latestRevisionId: newerRevisionId, latestRevisionNumber: 2, latestBody: "Plan body v2" })
      .where(eq(documents.id, scenario.planDocumentId));

    const snapshot = await svc.snapshot(scenario.issueId, scenario.board);

    expect(snapshot.planRevision).toMatchObject({
      acceptedRevisionId: scenario.planRevisionId,
      latestRevisionId: newerRevisionId,
      effectiveRevisionId: null,
      stale: true,
      staleReason: "superseded_by_newer_revision",
    });
    expect(snapshot.blockers).toContain("delivery_plan_revision_stale");
    await expectDenial(
      svc.submit(
        scenario.issueId,
        {
          expectedPlanRevisionId: scenario.planRevisionId,
          candidate: { repositoryUrl: REPOSITORY_URL, headSha: HEAD_SHA, baseSha: BASE_SHA },
        },
        scenario.writer,
      ),
      "delivery_plan_revision_stale",
    );
  }, 30_000);
});
