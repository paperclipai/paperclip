import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  blogArtifacts,
  blogPublishApprovals,
  blogRunStepAttempts,
  blogRuns,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { blogArtifactMirrorService } from "./blog-artifact-mirror.js";
import { resolveBlogIncidentRoute } from "./blog-incident-routing.js";

const STEP_SEQUENCE = [
  "research",
  "draft",
  "image",
  "draft_review",
  "draft_polish",
  "final_review",
  "validate",
  "publish",
  "public_verify",
] as const;

type BlogRunStatus =
  | "queued"
  | "research_running"
  | "research_ready"
  | "draft_running"
  | "draft_ready"
  | "image_running"
  | "image_ready"
  | "editorial_review_running"
  | "editorial_review_passed"
  | "draft_polish_running"
  | "draft_polish_passed"
  | "final_review_running"
  | "final_review_passed"
  | "validate_running"
  | "validated"
  | "publish_approval_pending"
  | "publish_approved"
  | "publish_running"
  | "published"
  | "public_verify_running"
  | "public_verified"
  | "review_required"
  | "resumable"
  | "failed";

type CreateBlogRunInput = {
  companyId: string;
  projectId: string;
  issueId?: string | null;
  topic: string;
  lane?: string | null;
  targetSite?: string | null;
  approvalMode?: string | null;
  publishMode?: string | null;
  contextJson?: Record<string, unknown> | null;
};

type CompleteStepInput = {
  attemptId: string;
  resultJson?: Record<string, unknown> | null;
  artifacts?: Array<{
    artifactKind: string;
    contentType: string;
    storageKind?: string | null;
    storagePath?: string | null;
    bodyPreview?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
};

type FailStepInput = {
  attemptId: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

type RequestResumeReviewInput = {
  recoveryAction: string;
  evidenceRefs: string[];
  requestedBy: string;
  notes?: string[];
};

type MarkResumableInput = {
  specialistAcknowledgedBy: string;
  operatorReviewedBy: string;
  evidenceRefs: string[];
  confirmedRequirements: string[];
  notes?: string[];
};

type PublishStopReason = {
  incidentId: string;
  openedAt: string;
  runId: string;
  pipelineKey: string;
  verticalKey: string;
  stepKey: string;
  failureName: string;
  classification: "auto_stop" | "follow_up";
  stopScope: "article" | "lane" | "step" | "none" | "global";
  stopActive: boolean;
  primaryOwner: string;
  supportingOwners: string[];
  escalationOwner: string;
  followUpTrack: string;
  publicRisk: "low" | "medium" | "high";
  recoverabilityRisk: "low" | "medium" | "high";
  artifactRefs: string[];
  currentDecision: string;
  resumeRequirements: string[];
  nextAction: string;
  lastUpdatedAt: string;
};

type RequestPublishApprovalInput = {
  targetSlug: string;
  siteId?: string | null;
  artifactHash: string;
  normalizedDomHash: string;
  policyVersion?: string | null;
  approvalKeyHash: string;
  approvalPayload?: Record<string, unknown> | null;
  approvedByAgentId?: string | null;
  approvedByUserId?: string | null;
  publishIdempotencyKey: string;
};

function normalizeLane(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "report") return "report";
  if (normalized === "draft_only" || normalized === "draft-only" || normalized === "draft") return "draft_only";
  return "publish";
}

function normalizePublishMode(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dry_run" || normalized === "dry-run" || normalized === "preview") return "dry_run";
  return normalized === "publish" ? "publish" : "draft";
}

function resolveInitialPublicVerifyContractMode(
  lane: string,
  publishMode: string,
  contextJson: Record<string, unknown> | null | undefined,
) {
  const explicit = String(contextJson?.publicVerifyContractMode ?? "").trim().toLowerCase();
  if (explicit === "strict" || explicit === "compat") return explicit;
  return lane === "publish" && publishMode === "publish" ? "strict" : "compat";
}

function resolveInitialPublishReadyGateMode(
  contextJson: Record<string, unknown> | null | undefined,
) {
  const explicit = String(contextJson?.publishReadyGateMode ?? "").trim().toLowerCase();
  if (explicit === "strict" || explicit === "compat") return explicit;
  return "compat";
}

function buildInitialContextJson(
  lane: string,
  publishMode: string,
  contextJson: Record<string, unknown> | null | undefined,
) {
  const base = contextJson && typeof contextJson === "object" && !Array.isArray(contextJson)
    ? { ...contextJson }
    : {};
  return {
    ...base,
    publicVerifyContractMode: resolveInitialPublicVerifyContractMode(lane, publishMode, base),
    publishReadyGateMode: resolveInitialPublishReadyGateMode(base),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toRunningStatus(stepKey: string): BlogRunStatus {
  switch (stepKey) {
    case "research":
      return "research_running";
    case "draft":
      return "draft_running";
    case "image":
      return "image_running";
    case "draft_review":
      return "editorial_review_running";
    case "draft_polish":
      return "draft_polish_running";
    case "final_review":
      return "final_review_running";
    case "validate":
      return "validate_running";
    case "publish":
      return "publish_running";
    case "public_verify":
      return "public_verify_running";
    default:
      return "queued";
  }
}

function nextStateAfterStep(stepKey: string) {
  switch (stepKey) {
    case "research":
      return { status: "research_ready" as BlogRunStatus, nextStep: "draft" };
    case "draft":
      return { status: "draft_ready" as BlogRunStatus, nextStep: "image" };
    case "image":
      return { status: "image_ready" as BlogRunStatus, nextStep: "draft_review" };
    case "draft_review":
      return { status: "editorial_review_passed" as BlogRunStatus, nextStep: "draft_polish" };
    case "draft_polish":
      return { status: "draft_polish_passed" as BlogRunStatus, nextStep: "final_review" };
    case "final_review":
      return { status: "final_review_passed" as BlogRunStatus, nextStep: "validate" };
    case "validate":
      return { status: "publish_approval_pending" as BlogRunStatus, nextStep: "publish" };
    case "publish":
      return { status: "published" as BlogRunStatus, nextStep: "public_verify" };
    case "public_verify":
      return { status: "public_verified" as BlogRunStatus, nextStep: null };
    default:
      return { status: "failed" as BlogRunStatus, nextStep: null };
  }
}

function buildRunArtifactRefs(runId: string, stepKey: string) {
  const refs = [`${runId}/status.json`];
  if (stepKey === "publish") refs.push(`${runId}/publish.json`);
  if (stepKey === "public_verify") {
    refs.push(`${runId}/publish.json`);
    refs.push(`${runId}/verify.json`);
  }
  if (stepKey === "research") refs.push(`${runId}/research.json`);
  if (stepKey === "draft") refs.push(`${runId}/draft.json`);
  if (stepKey === "validate") refs.push(`${runId}/validation.json`);
  return refs;
}

function derivePublishStopReason(
  run: typeof blogRuns.$inferSelect,
  stepKey: string,
  input: FailStepInput,
): PublishStopReason {
  const raw = `${String(input.errorCode ?? "")} ${String(input.errorMessage ?? "")}`.trim().toUpperCase();
  const context = (run.contextJson && typeof run.contextJson === "object" && !Array.isArray(run.contextJson))
    ? run.contextJson
    : {};
  const now = new Date().toISOString();
  const base = {
    incidentId: `incident-${run.id}-${stepKey}`,
    openedAt: now,
    runId: run.id,
    pipelineKey: "blog-os",
    verticalKey: String(context.verticalKey ?? context.category_family ?? "unknown"),
    stepKey,
    lastUpdatedAt: now,
    artifactRefs: buildRunArtifactRefs(run.id, stepKey),
  };

  if (raw.includes("APPROVAL")) {
    const route = resolveBlogIncidentRoute("APPROVAL_FAILURE");
    return {
      ...base,
      failureName: "APPROVAL_FAILURE",
      classification: "auto_stop",
      stopScope: "article",
      stopActive: true,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "high",
      recoverabilityRisk: "medium",
      currentDecision: "block publish path until a fresh approval is attached",
      resumeRequirements: ["fresh approval ID bound to the corrected approved package"],
      nextAction: "obtain a fresh approval for the corrected approved package",
    };
  }

  if (raw.includes("IDEMPOTENCY")) {
    const route = resolveBlogIncidentRoute("IDEMPOTENCY_ANOMALY");
    return {
      ...base,
      failureName: "IDEMPOTENCY_ANOMALY",
      classification: "auto_stop",
      stopScope: "lane",
      stopActive: true,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "high",
      recoverabilityRisk: "high",
      currentDecision: "freeze the lane until one canonical publish outcome is proven",
      resumeRequirements: ["one canonical publish outcome proven from ledger, receipt, and public state"],
      nextAction: "reconcile idempotency state across publish execution surfaces",
    };
  }

  if (raw.includes("WORDPRESS_WRITE_FORBIDDEN") || raw.includes("PUBLIC_VERIFY_CONTRACT_MISSING") || raw.includes("PUBLISH_BOUNDARY")) {
    const route = resolveBlogIncidentRoute("PUBLISH_BOUNDARY_MISMATCH");
    return {
      ...base,
      failureName: "PUBLISH_BOUNDARY_MISMATCH",
      classification: "auto_stop",
      stopScope: "lane",
      stopActive: true,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "high",
      recoverabilityRisk: "medium",
      currentDecision: "block the publish lane until the boundary contract is corrected",
      resumeRequirements: ["approved package checksum matches publish input bundle and boundary smoke passes"],
      nextAction: "repair the publish boundary contract and rerun the boundary smoke suite",
    };
  }

  if (raw.includes("BLOG_RUN_PUBLIC_VERIFY_FAILED") || raw.includes("PUBLIC_VERIFY_") || raw.includes("VERIFY_FAILED")) {
    const route = resolveBlogIncidentRoute("PUBLIC_VERIFY_FAILURE");
    return {
      ...base,
      failureName: "PUBLIC_VERIFY_FAILURE",
      classification: "auto_stop",
      stopScope: "article",
      stopActive: true,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "high",
      recoverabilityRisk: "medium",
      currentDecision: "quarantine the affected article and block replay",
      resumeRequirements: ["passing public verify verdict on the corrected or quarantined state"],
      nextAction: "repair or quarantine the public state and rerun public verify",
    };
  }

  if (raw.includes("BACKUP")) {
    const route = resolveBlogIncidentRoute("BACKUP_DELAY");
    return {
      ...base,
      failureName: "BACKUP_DELAY",
      classification: "follow_up",
      stopScope: "none",
      stopActive: false,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "low",
      recoverabilityRisk: "medium",
      currentDecision: "keep publish running but record the backup delay incident",
      resumeRequirements: ["required artifacts mirrored or manual stop decision recorded"],
      nextAction: "restore backup coverage or record a manual stop decision",
    };
  }

  if (raw.includes("COST")) {
    const route = resolveBlogIncidentRoute("EARLY_COST_ANOMALY");
    return {
      ...base,
      failureName: "EARLY_COST_ANOMALY",
      classification: "follow_up",
      stopScope: "none",
      stopActive: false,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "low",
      recoverabilityRisk: "low",
      currentDecision: "record the anomaly and keep the pipeline running",
      resumeRequirements: ["cost spike explained or policy changed explicitly"],
      nextAction: "inspect spend anomaly and record operator decision",
    };
  }

  if (stepKey === "research" || stepKey === "draft" || stepKey === "draft_review" || stepKey === "draft_polish" || stepKey === "final_review" || stepKey === "validate") {
    const route = resolveBlogIncidentRoute("RESEARCH_QUALITY_WOBBLE");
    return {
      ...base,
      failureName: "RESEARCH_QUALITY_WOBBLE",
      classification: "follow_up",
      stopScope: "article",
      stopActive: false,
      primaryOwner: route.primaryOwner,
      supportingOwners: route.supportingOwners,
      escalationOwner: route.escalationOwner,
      followUpTrack: route.followUpTrack,
      publicRisk: "medium",
      recoverabilityRisk: "low",
      currentDecision: "record the article-level quality incident without global stop",
      resumeRequirements: ["editorial correction or explicit rejection recorded"],
      nextAction: "repair the article or explicitly reject the run",
    };
  }

  const route = resolveBlogIncidentRoute("ROUTINE_PARTIAL_FAILURE");
  return {
    ...base,
    failureName: "ROUTINE_PARTIAL_FAILURE",
    classification: "follow_up",
    stopScope: "step",
    stopActive: false,
    primaryOwner: route.primaryOwner,
    supportingOwners: route.supportingOwners,
    escalationOwner: route.escalationOwner,
    followUpTrack: route.followUpTrack,
    publicRisk: "low",
    recoverabilityRisk: "medium",
    currentDecision: "keep the broader pipeline active while this step incident stays open",
    resumeRequirements: ["step either succeeds on allowed retry path or incident stays open"],
    nextAction: "route the failure to the owning specialist and retry if allowed",
  };
}

export function blogRunService(
  db: Db,
  deps?: {
    artifactMirror?: ReturnType<typeof blogArtifactMirrorService>;
  },
) {
  const artifactMirror = deps?.artifactMirror ?? blogArtifactMirrorService();

  async function getRunById(id: string) {
    return db.select().from(blogRuns).where(eq(blogRuns.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getAttempt(runId: string, attemptId: string, stepKey: string) {
    return db
      .select()
      .from(blogRunStepAttempts)
      .where(and(
        eq(blogRunStepAttempts.id, attemptId),
        eq(blogRunStepAttempts.blogRunId, runId),
        eq(blogRunStepAttempts.stepKey, stepKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  return {
    async create(input: CreateBlogRunInput) {
      const normalizedLane = normalizeLane(input.lane);
      const normalizedPublishMode = normalizePublishMode(input.publishMode);
      const initialContextJson = buildInitialContextJson(
        normalizedLane,
        normalizedPublishMode,
        input.contextJson ?? null,
      );
      const created = await db
        .insert(blogRuns)
        .values({
          companyId: input.companyId,
          projectId: input.projectId,
          issueId: input.issueId ?? null,
          topic: input.topic,
          lane: normalizedLane,
          targetSite: input.targetSite ?? "fluxaivory.com",
          status: "queued",
          currentStep: STEP_SEQUENCE[0],
          approvalMode: input.approvalMode ?? "manual",
          publishMode: normalizedPublishMode,
          contextJson: initialContextJson,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (created) {
        await artifactMirror.writeContext({
          id: created.id,
          topic: created.topic,
          lane: created.lane,
          targetSite: created.targetSite,
          publishMode: created.publishMode,
          wordpressPostId: created.wordpressPostId,
          createdAt: created.createdAt,
          contextJson: created.contextJson,
        });
        await artifactMirror.writeStatus(created.id, {
          phase: created.currentStep,
          state: "running",
          lastCompletedStep: null,
          nextStep: created.currentStep,
          error: null,
        });
      }
      return created;
    },

    async getById(id: string) {
      return getRunById(id);
    },

    async getDetail(id: string) {
      const run = await getRunById(id);
      if (!run) return null;
      const [attempts, artifacts, approvals] = await Promise.all([
        db.select().from(blogRunStepAttempts).where(eq(blogRunStepAttempts.blogRunId, id)).orderBy(
          asc(blogRunStepAttempts.createdAt),
          asc(blogRunStepAttempts.attemptNumber),
        ),
        db.select().from(blogArtifacts).where(eq(blogArtifacts.blogRunId, id)).orderBy(asc(blogArtifacts.createdAt)),
        db.select().from(blogPublishApprovals).where(eq(blogPublishApprovals.blogRunId, id)).orderBy(desc(blogPublishApprovals.createdAt)),
      ]);
      return { run, attempts, artifacts, approvals };
    },

    async listArtifacts(id: string) {
      return db.select().from(blogArtifacts).where(eq(blogArtifacts.blogRunId, id)).orderBy(asc(blogArtifacts.createdAt));
    },

    async claimNextStep(id: string) {
      const run = await getRunById(id);
      if (!run) throw notFound("Blog run not found");
      if (!run.currentStep) return null;
      if (run.status === "publish_approval_pending") {
        throw conflict("Publish approval is required before claiming publish");
      }
      if (run.status === "public_verified") return null;

      const priorAttempts = await db
        .select()
        .from(blogRunStepAttempts)
        .where(and(
          eq(blogRunStepAttempts.blogRunId, id),
          eq(blogRunStepAttempts.stepKey, run.currentStep),
        ))
        .orderBy(desc(blogRunStepAttempts.attemptNumber));

      const attemptNumber = (priorAttempts[0]?.attemptNumber ?? 0) + 1;
      const attempt = await db
        .insert(blogRunStepAttempts)
        .values({
          blogRunId: id,
          companyId: run.companyId,
          stepKey: run.currentStep,
          attemptNumber,
          status: "running",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      await db
        .update(blogRuns)
        .set({
          status: toRunningStatus(run.currentStep),
          updatedAt: new Date(),
          startedAt: run.startedAt ?? new Date(),
        })
        .where(eq(blogRuns.id, id));

      return {
        run: await getRunById(id),
        attempt,
      };
    },

    async completeStep(runId: string, stepKey: string, input: CompleteStepInput) {
      const run = await getRunById(runId);
      if (!run) throw notFound("Blog run not found");

      const attempt = await getAttempt(runId, input.attemptId, stepKey);
      if (!attempt) throw notFound("Blog run step attempt not found");

      await db
        .update(blogRunStepAttempts)
        .set({
          status: "completed",
          finishedAt: new Date(),
          resultJson: input.resultJson ?? null,
          updatedAt: new Date(),
        })
        .where(eq(blogRunStepAttempts.id, attempt.id));

      for (const artifact of input.artifacts ?? []) {
        await db.insert(blogArtifacts).values({
          blogRunId: runId,
          companyId: run.companyId,
          stepAttemptId: attempt.id,
          stepKey,
          artifactKind: artifact.artifactKind,
          contentType: artifact.contentType,
          storageKind: artifact.storageKind ?? "local_fs",
          storagePath: artifact.storagePath ?? null,
          bodyPreview: artifact.bodyPreview ?? null,
          metadata: artifact.metadata ?? null,
        });
      }

      const next = stepKey === "validate" && run.publishMode === "dry_run"
        ? { status: "publish_approved" as BlogRunStatus, nextStep: "publish" }
        : nextStateAfterStep(stepKey);
      const resultJson = input.resultJson ?? {};

      const updatePayload: Partial<typeof blogRuns.$inferInsert> = {
        status: next.status,
        currentStep: next.nextStep,
        updatedAt: new Date(),
      };

      if (stepKey === "publish") {
        const wordpressPostId = Number((resultJson as Record<string, unknown>).postId ?? (resultJson as Record<string, unknown>).post_id ?? 0) || null;
        const publishedUrl = String((resultJson as Record<string, unknown>).url ?? (resultJson as Record<string, unknown>).published_url ?? "").trim() || null;
        updatePayload.wordpressPostId = wordpressPostId;
        updatePayload.publishedUrl = publishedUrl;
      }
      if (stepKey === "public_verify") {
        updatePayload.completedAt = new Date();
      }

      await db.update(blogRuns).set(updatePayload).where(eq(blogRuns.id, runId));
      await artifactMirror.writeStepResult(runId, stepKey, resultJson);
      await artifactMirror.writeStepArtifacts(runId, stepKey, input.artifacts ?? []);
      await artifactMirror.writeStatus(runId, {
        phase: next.nextStep ?? stepKey,
        state: next.status === "public_verified" ? "completed" : "running",
        lastCompletedStep: stepKey,
        nextStep: next.nextStep,
        error: null,
      });
      return this.getDetail(runId);
    },

    async failStep(runId: string, stepKey: string, input: FailStepInput) {
      const run = await getRunById(runId);
      if (!run) throw notFound("Blog run not found");
      const attempt = await getAttempt(runId, input.attemptId, stepKey);
      if (!attempt) throw notFound("Blog run step attempt not found");

      await db
        .update(blogRunStepAttempts)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          updatedAt: new Date(),
        })
        .where(eq(blogRunStepAttempts.id, attempt.id));

      const stopReason = derivePublishStopReason(run, stepKey, input);

      await db
        .update(blogRuns)
        .set({
          status: "failed",
          failedReason: input.errorMessage ?? input.errorCode ?? stepKey,
          updatedAt: new Date(),
        })
        .where(eq(blogRuns.id, runId));

      await artifactMirror.writeStatus(runId, {
        phase: stepKey,
        state: "failed",
        lastCompletedStep: null,
        nextStep: stepKey,
        error: input.errorMessage ?? input.errorCode ?? stepKey,
        stopReason,
      });
      await artifactMirror.writeStopReason(runId, stopReason);

      return this.getDetail(runId);
    },

    async requestResumeReview(runId: string, input: RequestResumeReviewInput) {
      const run = await getRunById(runId);
      if (!run) throw notFound("Blog run not found");
      if (run.status !== "failed") {
        throw conflict("Resume review requires a failed blog run");
      }
      const stopReason = artifactMirror.readStopReason
        ? toRecord(await artifactMirror.readStopReason(runId))
        : {};
      if (Object.keys(stopReason).length === 0) {
        throw conflict("Resume review requires a persisted stop reason");
      }
      if (stopReason.stopActive !== true) {
        throw conflict("Resume review requires an active stop");
      }
      const recoveryAction = String(input.recoveryAction ?? "").trim();
      const requestedBy = String(input.requestedBy ?? "").trim();
      const evidenceRefs = Array.isArray(input.evidenceRefs)
        ? input.evidenceRefs.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      if (!recoveryAction) throw conflict("Resume review requires a recovery action");
      if (!requestedBy) throw conflict("Resume review requires requestedBy");
      if (evidenceRefs.length === 0) throw conflict("Resume review requires evidence references");

      const payload = {
        requestedAt: new Date().toISOString(),
        requestedBy,
        recoveryAction,
        evidenceRefs,
        notes: Array.isArray(input.notes) ? input.notes : [],
        stopReason,
      };

      await db
        .update(blogRuns)
        .set({
          status: "review_required",
          updatedAt: new Date(),
        })
        .where(eq(blogRuns.id, runId));

      if (artifactMirror.writeResumeReview) {
        await artifactMirror.writeResumeReview(runId, payload);
      }
      await artifactMirror.writeStatus(runId, {
        phase: run.currentStep ?? "publish",
        state: "review_required",
        lastCompletedStep: run.currentStep ?? null,
        nextStep: run.currentStep ?? "publish",
        error: run.failedReason ?? null,
        stopReason,
      });

      return {
        run: await getRunById(runId),
        resumeReview: payload,
      };
    },

    async markResumable(runId: string, input: MarkResumableInput) {
      const run = await getRunById(runId);
      if (!run) throw notFound("Blog run not found");
      if (run.status !== "review_required") {
        throw conflict("Resumable transition requires review_required status");
      }
      const stopReason = artifactMirror.readStopReason
        ? toRecord(await artifactMirror.readStopReason(runId))
        : {};
      if (Object.keys(stopReason).length === 0) {
        throw conflict("Resumable transition requires a persisted stop reason");
      }

      const specialistAcknowledgedBy = String(input.specialistAcknowledgedBy ?? "").trim();
      const operatorReviewedBy = String(input.operatorReviewedBy ?? "").trim();
      const evidenceRefs = Array.isArray(input.evidenceRefs)
        ? input.evidenceRefs.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      const confirmedRequirements = Array.isArray(input.confirmedRequirements)
        ? input.confirmedRequirements.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      if (!specialistAcknowledgedBy) throw conflict("Resumable transition requires specialistAcknowledgedBy");
      if (!operatorReviewedBy) throw conflict("Resumable transition requires operatorReviewedBy");
      if (evidenceRefs.length === 0) throw conflict("Resumable transition requires evidence references");

      const requiredResumeRequirements = Array.isArray(stopReason.resumeRequirements)
        ? stopReason.resumeRequirements.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
        : [];
      const missingRequirements = requiredResumeRequirements.filter(
        (requirement: string) => !confirmedRequirements.includes(requirement),
      );
      if (missingRequirements.length > 0) {
        throw conflict("Resumable transition requires all stop reason resume requirements to be confirmed", {
          missingRequirements,
        });
      }

      const payload = {
        markedAt: new Date().toISOString(),
        specialistAcknowledgedBy,
        operatorReviewedBy,
        evidenceRefs,
        confirmedRequirements,
        notes: Array.isArray(input.notes) ? input.notes : [],
        stopReason,
      };

      await db
        .update(blogRuns)
        .set({
          status: "resumable",
          updatedAt: new Date(),
        })
        .where(eq(blogRuns.id, runId));

      if (artifactMirror.writeResumeEvidence) {
        await artifactMirror.writeResumeEvidence(runId, payload);
      }
      await artifactMirror.writeStatus(runId, {
        phase: run.currentStep ?? "publish",
        state: "resumable",
        lastCompletedStep: run.currentStep ?? null,
        nextStep: run.currentStep ?? "publish",
        error: null,
        stopReason,
      });

      return {
        run: await getRunById(runId),
        resumeEvidence: payload,
      };
    },

    async requestPublishApproval(runId: string, input: RequestPublishApprovalInput) {
      const run = await getRunById(runId);
      if (!run) throw notFound("Blog run not found");

      const approval = await db
        .insert(blogPublishApprovals)
        .values({
          blogRunId: runId,
          companyId: run.companyId,
          targetSlug: input.targetSlug,
          siteId: input.siteId ?? run.targetSite,
          artifactHash: input.artifactHash,
          normalizedDomHash: input.normalizedDomHash,
          policyVersion: input.policyVersion ?? "publish-gateway-v1",
          approvalKeyHash: input.approvalKeyHash,
          approvalPayload: input.approvalPayload ?? null,
          approvedByAgentId: input.approvedByAgentId ?? null,
          approvedByUserId: input.approvedByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      await db
        .update(blogRuns)
        .set({
          approvalKeyHash: input.approvalKeyHash,
          publishIdempotencyKey: input.publishIdempotencyKey,
          status: "publish_approved",
          currentStep: "publish",
          updatedAt: new Date(),
        })
        .where(eq(blogRuns.id, runId));

      await artifactMirror.writeStatus(runId, {
        phase: "publish",
        state: "running",
        lastCompletedStep: "validate",
        nextStep: "publish",
        error: null,
      });

      return {
        run: await getRunById(runId),
        approval,
      };
    },
  };
}
