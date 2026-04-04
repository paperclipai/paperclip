import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  blogArtifacts,
  blogPublishApprovals,
  blogPublishExecutions,
  blogRunStepAttempts,
  blogRuns,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { blogRunService } from "../services/blog-runs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("blog run service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blog-runs-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(blogPublishExecutions);
    await db.delete(blogPublishApprovals);
    await db.delete(blogArtifacts);
    await db.delete(blogRunStepAttempts);
    await db.delete(blogRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Blog pipeline",
      status: "in_progress",
    });
    return { companyId, projectId };
  }

  it("creates a run and returns detail with empty attempts and artifacts", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);

    const created = await svc.create({
      companyId,
      projectId,
      topic: "Test topic",
      lane: "publish",
      publishMode: "draft",
    });

    expect(created?.status).toBe("queued");
    expect(created?.currentStep).toBe("research");
    expect(created?.contextJson).toMatchObject({
      publicVerifyContractMode: "compat",
    });

    const detail = await svc.getDetail(created!.id);
    expect(detail?.run.id).toBe(created?.id);
    expect(detail?.attempts).toEqual([]);
    expect(detail?.artifacts).toEqual([]);
  });

  it("defaults live publish runs to strict public verify contract mode", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);

    const created = await svc.create({
      companyId,
      projectId,
      topic: "Strict mode topic",
      lane: "publish",
      publishMode: "publish",
    });

    expect(created?.contextJson).toMatchObject({
      publicVerifyContractMode: "strict",
    });
  });

  it("preserves an explicit public verify contract mode override", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);

    const created = await svc.create({
      companyId,
      projectId,
      topic: "Override mode topic",
      lane: "publish",
      publishMode: "publish",
      contextJson: {
        publicVerifyContractMode: "compat",
        custom: "keep-me",
      },
    });

    expect(created?.contextJson).toMatchObject({
      publicVerifyContractMode: "compat",
      publishReadyGateMode: "compat",
      custom: "keep-me",
    });
  });

  it("persists publishReadyGateMode defaults and preserves explicit override", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);

    const defaultRun = await svc.create({
      companyId,
      projectId,
      topic: "Default gate topic",
      lane: "publish",
      publishMode: "publish",
      contextJson: {},
    });

    expect(defaultRun?.contextJson).toMatchObject({
      publishReadyGateMode: "compat",
      publicVerifyContractMode: "strict",
    });

    const explicitRun = await svc.create({
      companyId,
      projectId,
      topic: "Explicit gate topic",
      lane: "publish",
      publishMode: "publish",
      contextJson: {
        publishReadyGateMode: "strict",
      },
    });

    expect(explicitRun?.contextJson).toMatchObject({
      publishReadyGateMode: "strict",
      publicVerifyContractMode: "strict",
    });
  });

  it("upgrades dry-run canary runs to strict publishReadyGateMode", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);

    const canaryRun = await svc.create({
      companyId,
      projectId,
      topic: "Canary gate topic",
      lane: "publish",
      publishMode: "dry_run",
      contextJson: {
        publishReadyGateCanary: true,
      },
    });

    expect(canaryRun?.contextJson).toMatchObject({
      publishReadyGateCanary: true,
      publishReadyGateMode: "strict",
      publicVerifyContractMode: "compat",
    });
  });

  it("claims and completes the research step, advancing to draft", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);
    const created = await svc.create({
      companyId,
      projectId,
      topic: "Research topic",
    });

    const claimed = await svc.claimNextStep(created!.id);
    expect(claimed?.attempt?.stepKey).toBe("research");
    expect(claimed?.run?.status).toBe("research_running");

    const completed = await svc.completeStep(created!.id, "research", {
      attemptId: claimed!.attempt!.id,
      resultJson: { bundlePath: "/tmp/research.json" },
      artifacts: [{
        artifactKind: "research_json",
        contentType: "application/json",
        storagePath: "/tmp/research.json",
      }],
    });

    expect(completed?.run.status).toBe("research_ready");
    expect(completed?.run.currentStep).toBe("draft");
    expect(completed?.artifacts).toHaveLength(1);
  });

  it("moves validated runs into publish approval pending, then publish approved", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);
    const created = await svc.create({
      companyId,
      projectId,
      topic: "Validation topic",
    });

    await db.update(blogRuns).set({
      status: "validate_running",
      currentStep: "validate",
    }).where(eq(blogRuns.id, created!.id));
    const attempt = await db.insert(blogRunStepAttempts).values({
      blogRunId: created!.id,
      companyId,
      stepKey: "validate",
      attemptNumber: 1,
      status: "running",
      startedAt: new Date(),
    }).returning().then((rows) => rows[0]!);

    const validated = await svc.completeStep(created!.id, "validate", {
      attemptId: attempt.id,
      resultJson: { ok: true },
    });

    expect(validated?.run.status).toBe("publish_approval_pending");
    expect(validated?.run.currentStep).toBe("publish");

    const approved = await svc.requestPublishApproval(created!.id, {
      targetSlug: "validation-topic",
      artifactHash: "artifact-hash",
      normalizedDomHash: "dom-hash",
      approvalKeyHash: "approval-hash",
      publishIdempotencyKey: "publish-key",
      approvedByUserId: "operator",
    });

    expect(approved.run?.status).toBe("publish_approved");
    expect(approved.run?.publishIdempotencyKey).toBe("publish-key");
    expect(approved.approval?.approvalKeyHash).toBe("approval-hash");
  });

  it("records failure on a step attempt and marks the run failed", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);
    const created = await svc.create({
      companyId,
      projectId,
      topic: "Failure topic",
    });

    const claimed = await svc.claimNextStep(created!.id);
    const failed = await svc.failStep(created!.id, "research", {
      attemptId: claimed!.attempt!.id,
      errorCode: "RESEARCH_ERROR",
      errorMessage: "research_bundle_missing",
    });

    expect(failed?.run.status).toBe("failed");
    expect(failed?.run.failedReason).toBe("research_bundle_missing");
    expect(failed?.attempts[0]?.status).toBe("failed");
  });

  it("moves an auto-stopped run through review_required to resumable when evidence satisfies the resume gate", async () => {
    const { companyId, projectId } = await seedProject();
    const svc = blogRunService(db);
    const created = await svc.create({
      companyId,
      projectId,
      topic: "Resume gate topic",
      lane: "publish",
      publishMode: "publish",
    });

    const claimed = await svc.claimNextStep(created!.id);
    await svc.failStep(created!.id, "research", {
      attemptId: claimed!.attempt!.id,
      errorCode: "BLOG_RUN_PUBLIC_VERIFY_FAILED",
      errorMessage: "blog_run_public_verify_failed:PUBLIC_VERIFY_REGRESSION",
    });

    const review = await svc.requestResumeReview(created!.id, {
      recoveryAction: "quarantine public article and re-run verify on corrected state",
      evidenceRefs: ["runs/run-20260404-001/verify/verdict.json"],
      requestedBy: "operations-lead",
      notes: ["Public result quarantined pending corrected verify pass."],
    });

    expect(review?.run.status).toBe("review_required");

    const resumable = await svc.markResumable(created!.id, {
      specialistAcknowledgedBy: "publish-verify",
      operatorReviewedBy: "operations-lead",
      evidenceRefs: [
        "runs/run-20260404-001/verify/verdict.json",
        "runs/run-20260404-001/publish/receipt.json",
      ],
      confirmedRequirements: [
        "passing public verify verdict on the corrected or quarantined state",
      ],
      notes: ["Verified corrected state and acknowledged by owner."],
    });

    expect(resumable?.run.status).toBe("resumable");
  });
});
