import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  microDependencyRequests,
  microEvidencePacks,
  microExperiments,
  microPods,
  microPromotionRequests,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

export interface RegistryActor {
  agentId?: string | null;
  userId?: string | null;
}

export interface CreateMicroPodInput {
  paperclipIssueId?: string | null;
  identifier: string;
  title: string;
  source: string;
  thesis: string;
  ownerAgentId?: string | null;
  lifecycleState?: string;
  dependencies?: unknown[];
}

export interface CreateMicroExperimentInput {
  paperclipIssueId?: string | null;
  identifier: string;
  title: string;
  hypothesis: string;
  sourceKind: string;
  sourceUrl?: string | null;
  lifecycleState?: string;
  maxImprovementAttempts?: number;
  holdingPeriodMinMinutes?: number;
  holdingPeriodMaxMinutes?: number | null;
  metrics?: Record<string, unknown>;
}

export interface UpdateExperimentVerdictInput {
  verdict: string;
  verdictReason: string;
  lifecycleState?: string;
}

export interface BoardReviewInput {
  decision: "approve_local_dry_run_plan" | "needs_revision" | "hold";
  note?: string | null;
}

export interface CreateDependencyRequestInput {
  podId?: string | null;
  experimentId?: string | null;
  kind: string;
  title: string;
  description?: string | null;
  routedToAgentId?: string | null;
  paperclipIssueId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateEvidencePackInput {
  podId?: string | null;
  experimentId?: string | null;
  title: string;
  artifactUri: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreatePromotionRequestInput {
  podId?: string | null;
  experimentId?: string | null;
  evidencePackId?: string | null;
  target: string;
  rationale: string;
  riskNotes?: string | null;
  paperclipIssueId?: string | null;
  metadata?: Record<string, unknown>;
}

export function microRegistryService(db: Db) {
  async function overview(companyId: string) {
    const [pods, experiments, dependencyRequests, evidencePacks, promotionRequests] = await Promise.all([
      db.select().from(microPods).where(eq(microPods.companyId, companyId)).orderBy(desc(microPods.updatedAt)),
      db.select().from(microExperiments).where(eq(microExperiments.companyId, companyId)).orderBy(desc(microExperiments.updatedAt)),
      db.select().from(microDependencyRequests).where(eq(microDependencyRequests.companyId, companyId)).orderBy(desc(microDependencyRequests.updatedAt)),
      db.select().from(microEvidencePacks).where(eq(microEvidencePacks.companyId, companyId)).orderBy(desc(microEvidencePacks.updatedAt)),
      db.select().from(microPromotionRequests).where(eq(microPromotionRequests.companyId, companyId)).orderBy(desc(microPromotionRequests.updatedAt)),
    ]);
    return { pods, experiments, dependencyRequests, evidencePacks, promotionRequests };
  }

  async function createPod(companyId: string, input: CreateMicroPodInput, actor: RegistryActor) {
    const [created] = await db.insert(microPods).values({
      companyId,
      paperclipIssueId: input.paperclipIssueId ?? null,
      identifier: input.identifier,
      title: input.title,
      source: input.source,
      thesis: input.thesis,
      ownerAgentId: input.ownerAgentId ?? null,
      lifecycleState: input.lifecycleState ?? "draft",
      dependencies: input.dependencies ?? [],
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    }).returning();
    return created;
  }

  async function createExperiment(
    companyId: string,
    podId: string,
    input: CreateMicroExperimentInput,
    actor: RegistryActor,
  ) {
    const [pod] = await db.select({ id: microPods.id })
      .from(microPods)
      .where(and(eq(microPods.companyId, companyId), eq(microPods.id, podId)))
      .limit(1);
    if (!pod) throw notFound("Micro pod not found");

    const [created] = await db.insert(microExperiments).values({
      companyId,
      podId,
      paperclipIssueId: input.paperclipIssueId ?? null,
      identifier: input.identifier,
      title: input.title,
      hypothesis: input.hypothesis,
      sourceKind: input.sourceKind,
      sourceUrl: input.sourceUrl ?? null,
      lifecycleState: input.lifecycleState ?? "draft",
      maxImprovementAttempts: input.maxImprovementAttempts ?? 5,
      improvementAttemptCount: 0,
      overnightAllowed: false,
      holdingPeriodMinMinutes: input.holdingPeriodMinMinutes ?? 1,
      holdingPeriodMaxMinutes: input.holdingPeriodMaxMinutes ?? null,
      metrics: input.metrics ?? {},
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    }).returning();
    return created;
  }

  async function updateExperimentVerdict(
    companyId: string,
    experimentId: string,
    input: UpdateExperimentVerdictInput,
  ) {
    const [updated] = await db.update(microExperiments)
      .set({
        verdict: input.verdict,
        verdictReason: input.verdictReason,
        lifecycleState: input.lifecycleState ?? "evidence_review",
        updatedAt: new Date(),
      })
      .where(and(eq(microExperiments.companyId, companyId), eq(microExperiments.id, experimentId)))
      .returning();
    if (!updated) throw notFound("Micro experiment not found");
    return updated;
  }

  async function recordBoardReview(
    companyId: string,
    experimentId: string,
    input: BoardReviewInput,
    actor: RegistryActor,
  ) {
    const [existing] = await db.select({ metrics: microExperiments.metrics })
      .from(microExperiments)
      .where(and(eq(microExperiments.companyId, companyId), eq(microExperiments.id, experimentId)))
      .limit(1);
    if (!existing) throw notFound("Micro experiment not found");

    const nextLifecycle = input.decision === "approve_local_dry_run_plan"
      ? "approved_for_local_dry_run"
      : input.decision === "needs_revision"
        ? "needs_revision"
        : "board_hold";
    const metrics = {
      ...(existing.metrics ?? {}),
      boardReview: {
        decision: input.decision,
        note: input.note ?? null,
        reviewerUserId: actor.userId ?? null,
        reviewerAgentId: actor.agentId ?? null,
        reviewedAt: new Date().toISOString(),
        executionAuthorized: false,
        paidComputeAuthorized: false,
        brokerActionsAuthorized: false,
      },
      executionAuthorized: false,
      paidComputeAuthorized: false,
      brokerActionsAuthorized: false,
    };

    const [updated] = await db.update(microExperiments)
      .set({ lifecycleState: nextLifecycle, metrics, updatedAt: new Date() })
      .where(and(eq(microExperiments.companyId, companyId), eq(microExperiments.id, experimentId)))
      .returning();
    if (!updated) throw notFound("Micro experiment not found");
    return updated;
  }

  async function createDependencyRequest(companyId: string, input: CreateDependencyRequestInput) {
    const [created] = await db.insert(microDependencyRequests).values({
      companyId,
      podId: input.podId ?? null,
      experimentId: input.experimentId ?? null,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      routedToAgentId: input.routedToAgentId ?? null,
      paperclipIssueId: input.paperclipIssueId ?? null,
      metadata: input.metadata ?? {},
    }).returning();
    return created;
  }

  async function createEvidencePack(companyId: string, input: CreateEvidencePackInput) {
    const [created] = await db.insert(microEvidencePacks).values({
      companyId,
      podId: input.podId ?? null,
      experimentId: input.experimentId ?? null,
      title: input.title,
      artifactUri: input.artifactUri,
      summary: input.summary ?? null,
      metadata: input.metadata ?? {},
    }).returning();
    return created;
  }

  async function createPromotionRequest(companyId: string, input: CreatePromotionRequestInput) {
    const [created] = await db.insert(microPromotionRequests).values({
      companyId,
      podId: input.podId ?? null,
      experimentId: input.experimentId ?? null,
      evidencePackId: input.evidencePackId ?? null,
      target: input.target,
      rationale: input.rationale,
      riskNotes: input.riskNotes ?? null,
      paperclipIssueId: input.paperclipIssueId ?? null,
      metadata: input.metadata ?? {},
    }).returning();
    return created;
  }

  return {
    overview,
    createPod,
    createExperiment,
    updateExperimentVerdict,
    recordBoardReview,
    createDependencyRequest,
    createEvidencePack,
    createPromotionRequest,
  };
}
