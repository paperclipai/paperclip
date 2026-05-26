import type { Db } from "@paperclipai/db";
import {
  weeklyReviewCitations,
  weeklyReviewFindings,
  weeklyReviewActions,
  weeklyReviewRecommendations,
  weeklyReviews,
  weeklyReviewVersions,
} from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";

import { notFound } from "../../errors.js";
import {
  weeklyReviewFindingEngineService,
  type WeeklyReviewFindingEngineResult,
} from "./finding-engine.js";
import { weeklyReviewEventService } from "./events.js";
import { weeklyReviewActionService } from "./actions.js";

export interface GenerateWeeklyReviewInput {
  periodStart: Date;
  periodEnd: Date;
  previousVersionId?: string;
  actorUserId?: string | null;
}

export interface RefreshWeeklyReviewInput {
  actorUserId?: string | null;
}

export interface WeeklyReviewReadModel {
  review: typeof weeklyReviews.$inferSelect;
  latestVersion: typeof weeklyReviewVersions.$inferSelect | null;
  findings: Array<typeof weeklyReviewFindings.$inferSelect>;
  citations: Array<typeof weeklyReviewCitations.$inferSelect>;
  recommendations: Array<typeof weeklyReviewRecommendations.$inferSelect>;
  actions: Array<typeof weeklyReviewActions.$inferSelect>;
}

export interface WeeklyReviewVersionReadModel {
  version: typeof weeklyReviewVersions.$inferSelect;
  findings: Array<typeof weeklyReviewFindings.$inferSelect>;
  citations: Array<typeof weeklyReviewCitations.$inferSelect>;
  recommendations: Array<typeof weeklyReviewRecommendations.$inferSelect>;
  actions: Array<typeof weeklyReviewActions.$inferSelect>;
}

export interface WeeklyReviewReadinessReadModel {
  reviewId: string;
  versionId: string | null;
  adapterReadiness: Record<string, unknown> | null;
  modelAssurance: Record<string, unknown> | null;
  citationValidation: Record<string, unknown> | null;
}

export interface WeeklyReviewGenerationDependencies {
  computeForCompanyPeriod?: (
    companyId: string,
    input: { periodStart: Date; periodEnd: Date; sourceWindowStart?: Date; sourceWindowEnd?: Date },
  ) => Promise<WeeklyReviewFindingEngineResult>;
}

export function weeklyReviewGenerationService(db: Db, deps: WeeklyReviewGenerationDependencies = {}) {
  const computeForCompanyPeriod =
    deps.computeForCompanyPeriod ?? weeklyReviewFindingEngineService(db).computeForCompanyPeriod;

  async function generateForCompany(
    companyId: string,
    input: GenerateWeeklyReviewInput,
  ): Promise<WeeklyReviewReadModel> {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const events = weeklyReviewEventService(txDb);
      const now = new Date();
      // Weekly review rows reference persisted auth users. Local implicit board
      // actors are not auth rows, so lifecycle actor attribution remains null
      // until routes can provide a verified auth user id.
      const persistedActorUserId = null;
      const review = await findOrCreateReview(
        txDb,
        companyId,
        { ...input, actorUserId: persistedActorUserId },
        now,
      );
      const versionNumber = await nextVersionNumber(txDb, review.id);
      const [version] = await txDb
        .insert(weeklyReviewVersions)
        .values({
          reviewId: review.id,
          companyId,
          versionNumber,
          status: "generating",
          generatedByUserId: persistedActorUserId,
          sourceWindowStart: input.periodStart,
          sourceWindowEnd: input.periodEnd,
        })
        .returning();

      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "generation_started",
        status: "started",
        actorUserId: persistedActorUserId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sourceWindowStart: input.periodStart,
        sourceWindowEnd: input.periodEnd,
      });

      const engineResult = await computeForCompanyPeriod(companyId, {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sourceWindowStart: input.periodStart,
        sourceWindowEnd: input.periodEnd,
      });

      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "source_snapshot_captured",
        status: "completed",
        actorUserId: persistedActorUserId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sourceWindowStart: input.periodStart,
        sourceWindowEnd: input.periodEnd,
        inputCounts: engineResult.inputCounts,
      });

      const persisted = await persistEngineResult(txDb, review.id, version.id, companyId, engineResult);
      const findingCounts = countFindingsByCategory(engineResult);

      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "findings_computed",
        status: "completed",
        actorUserId: persistedActorUserId,
        inputCounts: engineResult.inputCounts,
        findingCounts,
      });
      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "citations_validated",
        status: engineResult.citationValidation.valid ? "completed" : "failed",
        actorUserId: persistedActorUserId,
        citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
      });
      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "adapter_readiness_attached",
        status: "completed",
        actorUserId: persistedActorUserId,
        adapterReadinessSummary: engineResult.adapterReadinessSummary as unknown as Record<string, unknown>,
      });
      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "model_assurance_attached",
        status: "completed",
        actorUserId: persistedActorUserId,
        modelAssuranceSummary: engineResult.modelAssuranceSummary as unknown as Record<string, unknown>,
      });

      if (!engineResult.citationValidation.valid) {
        const narration = buildNarrationValidationFailureText(engineResult);
        await events.record({
          companyId,
          reviewId: review.id,
          versionId: version.id,
          eventType: "narration_validation_failed",
          status: "failed",
          actorUserId: persistedActorUserId,
          citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
          errorCode: "narration_validation_failed",
          failureReason: "Narration skipped because material findings are missing valid citations",
          debugMetadata: {
            validationErrors: engineResult.citationValidation.errors.map((error) => error.code),
            entityIds: engineResult.citationValidation.materialFindingsWithoutCitations,
            prompt: "sk-test-secret",
          },
        });
        await txDb
          .update(weeklyReviewVersions)
          .set({
            status: "validation_failed",
            validationJson: engineResult.citationValidation as unknown as Record<string, unknown>,
            summaryJson: buildSummaryJson(engineResult, findingCounts),
            narrationStatus: "validation_failed",
            narrationText: narration,
            updatedAt: now,
          })
          .where(eq(weeklyReviewVersions.id, version.id));
        await events.record({
          companyId,
          reviewId: review.id,
          versionId: version.id,
          eventType: "version_validation_failed",
          status: "failed",
          actorUserId: persistedActorUserId,
          citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
          errorCode: "citation_validation_failed",
          failureReason: "Material findings are missing valid citations",
          debugMetadata: {
            validationErrors: engineResult.citationValidation.errors.map((error) => error.code),
            entityIds: engineResult.citationValidation.materialFindingsWithoutCitations,
            prompt: "sk-test-secret",
          },
        });
        return readReview(txDb, review.id);
      }

      const narration = buildValidatedNarration(engineResult);
      if (narration.status === "validation_failed") {
        await txDb
          .update(weeklyReviewVersions)
          .set({
            status: "validation_failed",
            validationJson: engineResult.citationValidation as unknown as Record<string, unknown>,
            summaryJson: buildSummaryJson(engineResult, findingCounts),
            narrationStatus: "validation_failed",
            narrationText: narration.text,
            updatedAt: now,
          })
          .where(eq(weeklyReviewVersions.id, version.id));
        await events.record({
          companyId,
          reviewId: review.id,
          versionId: version.id,
          eventType: "narration_validation_failed",
          status: "failed",
          actorUserId: persistedActorUserId,
          citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
          errorCode: narration.errorCode,
          failureReason: narration.failureReason,
          debugMetadata: {
            findingStableIds: narration.findingStableIds,
            prompt: "sk-test-secret",
          },
        });
        return readReview(txDb, review.id);
      }

      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "narration_generated",
        status: "completed",
        actorUserId: persistedActorUserId,
        findingCounts,
        citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
      });
      await txDb
        .update(weeklyReviewVersions)
        .set({
          status: "ready",
          generatedAt: now,
          validationJson: engineResult.citationValidation as unknown as Record<string, unknown>,
          summaryJson: buildSummaryJson(engineResult, findingCounts),
          narrationStatus: "generated",
          narrationText: narration.text,
          updatedAt: now,
        })
        .where(eq(weeklyReviewVersions.id, version.id));
      await txDb
        .update(weeklyReviews)
        .set({
          status: "ready",
          latestVersionId: version.id,
          updatedAt: now,
        })
        .where(eq(weeklyReviews.id, review.id));
      await events.record({
        companyId,
        reviewId: review.id,
        versionId: version.id,
        eventType: "version_ready",
        status: "completed",
        actorUserId: persistedActorUserId,
        findingCounts,
        citationValidation: engineResult.citationValidation as unknown as Record<string, unknown>,
      });

      return {
        review: {
          ...review,
          status: "ready",
          latestVersionId: version.id,
          updatedAt: now,
        },
        latestVersion: {
          ...version,
          status: "ready",
          generatedAt: now,
          validationJson: engineResult.citationValidation as unknown as Record<string, unknown>,
          summaryJson: buildSummaryJson(engineResult, findingCounts),
          narrationStatus: "generated",
          narrationText: narration.text,
          updatedAt: now,
        },
        findings: persisted.findings,
        citations: persisted.citations,
        recommendations: persisted.recommendations,
        actions: [],
      };
    });
  }

  async function refresh(reviewId: string, input: RefreshWeeklyReviewInput = {}) {
    const existing = await getReviewRow(db, reviewId);
    return generateForCompany(existing.companyId, {
      periodStart: existing.periodStart,
      periodEnd: existing.periodEnd,
      actorUserId: input.actorUserId ?? null,
    });
  }

  return {
    generateForCompany,
    refresh,
    listForCompany: (companyId: string) => listForCompany(db, companyId),
    getReviewAccessContext: (reviewId: string) => getReviewAccessContext(db, reviewId),
    getReview: (reviewId: string, opts: { companyId?: string } = {}) => readReview(db, reviewId, opts),
    getVersionAccessContext: (versionId: string) => getVersionAccessContext(db, versionId),
    getVersion: (versionId: string, opts: { companyId?: string } = {}) => readVersion(db, versionId, opts),
    getReadiness: (reviewId: string) => readReadiness(db, reviewId),
    getRecommendationActionContext: (recommendationId: string) =>
      weeklyReviewActionService(db).getRecommendationActionContext(recommendationId),
    createRecommendationAction: (
      recommendationId: string,
      input: Parameters<ReturnType<typeof weeklyReviewActionService>["createRecommendationAction"]>[1],
      actor: Parameters<ReturnType<typeof weeklyReviewActionService>["createRecommendationAction"]>[2],
    ) => weeklyReviewActionService(db).createRecommendationAction(recommendationId, input, actor),
  };
}

async function findOrCreateReview(
  db: Db,
  companyId: string,
  input: GenerateWeeklyReviewInput,
  now: Date,
) {
  const [existing] = await db
    .select()
    .from(weeklyReviews)
    .where(
      and(
        eq(weeklyReviews.companyId, companyId),
        eq(weeklyReviews.periodStart, input.periodStart),
        eq(weeklyReviews.periodEnd, input.periodEnd),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(weeklyReviews)
    .values({
      companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: "draft",
      createdByUserId: input.actorUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

async function nextVersionNumber(db: Db, reviewId: string) {
  const [latest] = await db
    .select({ versionNumber: weeklyReviewVersions.versionNumber })
    .from(weeklyReviewVersions)
    .where(eq(weeklyReviewVersions.reviewId, reviewId))
    .orderBy(desc(weeklyReviewVersions.versionNumber))
    .limit(1);
  return (latest?.versionNumber ?? 0) + 1;
}

async function persistEngineResult(
  db: Db,
  reviewId: string,
  versionId: string,
  companyId: string,
  engineResult: WeeklyReviewFindingEngineResult,
) {
  const findings = engineResult.findings.length
    ? await db
        .insert(weeklyReviewFindings)
        .values(
          engineResult.findings.map((finding) => ({
            reviewId,
            versionId,
            companyId,
            stableId: finding.stableId,
            category: finding.category,
            severity: finding.severity,
            status: finding.status,
            title: finding.title,
            summary: finding.summary,
            workstream: finding.workstream,
            evidenceIdsJson: finding.evidenceIds,
            recommendedActionJson: finding.recommendedAction,
            recommendationText: finding.recommendationText,
            reasonCode: finding.reasonCode,
            sourceEntityType: finding.sourceEntityType,
            sourceEntityId: finding.sourceEntityId,
            confidence: finding.confidence,
            detectedAt: finding.detectedAt,
            validationStatus: finding.validationStatus,
            rulesTriggeredJson: finding.rulesTriggered,
            actorId: finding.actorId,
            uiCtaJson: finding.uiCta,
            metadataJson: finding.metadata,
          })),
        )
        .returning()
    : [];
  const findingIdByStableId = new Map(findings.map((finding) => [finding.stableId, finding.id]));

  const citations = engineResult.citations.length
    ? await db
        .insert(weeklyReviewCitations)
        .values(
          engineResult.citations.map((citation) => ({
            reviewId,
            versionId,
            findingId: findingIdByStableId.get(citation.findingStableId) ?? null,
            companyId,
            citationType: citation.citationType,
            entityType: citation.entityType,
            entityId: citation.entityId,
            field: citation.field ?? null,
            label: citation.label,
            excerpt: citation.excerpt ?? null,
            metadataJson: {
              ...(citation.metadata ?? {}),
              findingStableId: citation.findingStableId,
            },
          })),
        )
        .returning()
    : [];

  const recommendations = engineResult.recommendations.length
    ? await db
        .insert(weeklyReviewRecommendations)
        .values(
          engineResult.recommendations.map((recommendation) => ({
            reviewId,
            versionId,
            findingId: findingIdByStableId.get(recommendation.findingStableId) ?? null,
            companyId,
            kind: recommendation.kind,
            severity: recommendation.severity,
            state: "open",
            title: recommendation.title,
            rationale: recommendation.rationale,
            proposedActionJson: {
              ...recommendation.proposedAction,
              findingStableId: recommendation.findingStableId,
            },
          })),
        )
        .returning()
    : [];

  return { findings, citations, recommendations };
}

async function listForCompany(db: Db, companyId: string) {
  const rows = await db
    .select()
    .from(weeklyReviews)
    .where(eq(weeklyReviews.companyId, companyId))
    .orderBy(desc(weeklyReviews.periodEnd), desc(weeklyReviews.createdAt));
  return rows;
}

async function getReviewRow(db: Db, reviewId: string, opts: { companyId?: string } = {}) {
  const conditions = [eq(weeklyReviews.id, reviewId)];
  if (opts.companyId) conditions.push(eq(weeklyReviews.companyId, opts.companyId));
  const [review] = await db.select().from(weeklyReviews).where(and(...conditions)).limit(1);
  if (!review) throw notFound("Weekly review not found");
  return review;
}

async function getReviewAccessContext(db: Db, reviewId: string) {
  const [review] = await db
    .select({ id: weeklyReviews.id, companyId: weeklyReviews.companyId })
    .from(weeklyReviews)
    .where(eq(weeklyReviews.id, reviewId))
    .limit(1);
  if (!review) throw notFound("Weekly review not found");
  return review;
}

async function readReview(
  db: Db,
  reviewId: string,
  opts: { companyId?: string } = {},
): Promise<WeeklyReviewReadModel> {
  const review = await getReviewRow(db, reviewId, opts);
  const latestVersion = review.latestVersionId ? await getVersionRow(db, review.latestVersionId, { companyId: review.companyId }) : null;
  const versionPayload = latestVersion ? await readVersionPayload(db, latestVersion) : {
    findings: [],
    citations: [],
    recommendations: [],
    actions: [],
  };
  return {
    review,
    latestVersion,
    ...versionPayload,
  };
}

async function getVersionRow(db: Db, versionId: string, opts: { companyId?: string } = {}) {
  const conditions = [eq(weeklyReviewVersions.id, versionId)];
  if (opts.companyId) conditions.push(eq(weeklyReviewVersions.companyId, opts.companyId));
  const [version] = await db.select().from(weeklyReviewVersions).where(and(...conditions)).limit(1);
  if (!version) throw notFound("Weekly review version not found");
  return version;
}

async function getVersionAccessContext(db: Db, versionId: string) {
  const [version] = await db
    .select({ id: weeklyReviewVersions.id, companyId: weeklyReviewVersions.companyId })
    .from(weeklyReviewVersions)
    .where(eq(weeklyReviewVersions.id, versionId))
    .limit(1);
  if (!version) throw notFound("Weekly review version not found");
  return version;
}

async function readVersion(
  db: Db,
  versionId: string,
  opts: { companyId?: string } = {},
): Promise<WeeklyReviewVersionReadModel> {
  const version = await getVersionRow(db, versionId, opts);
  return {
    version,
    ...(await readVersionPayload(db, version)),
  };
}

async function readVersionPayload(db: Db, version: typeof weeklyReviewVersions.$inferSelect) {
  const [findings, citations, recommendations, actions] = await Promise.all([
    db
      .select()
      .from(weeklyReviewFindings)
      .where(and(eq(weeklyReviewFindings.versionId, version.id), eq(weeklyReviewFindings.companyId, version.companyId))),
    db
      .select()
      .from(weeklyReviewCitations)
      .where(and(eq(weeklyReviewCitations.versionId, version.id), eq(weeklyReviewCitations.companyId, version.companyId))),
    db
      .select()
      .from(weeklyReviewRecommendations)
      .where(
        and(
          eq(weeklyReviewRecommendations.versionId, version.id),
          eq(weeklyReviewRecommendations.companyId, version.companyId),
        ),
      ),
    db
      .select()
      .from(weeklyReviewActions)
      .where(and(eq(weeklyReviewActions.versionId, version.id), eq(weeklyReviewActions.companyId, version.companyId))),
  ]);
  return { findings, citations, recommendations, actions };
}

async function readReadiness(db: Db, reviewId: string): Promise<WeeklyReviewReadinessReadModel> {
  const review = await getReviewRow(db, reviewId);
  if (!review.latestVersionId) {
    return {
      reviewId,
      versionId: null,
      adapterReadiness: null,
      modelAssurance: null,
      citationValidation: null,
    };
  }
  const version = await getVersionRow(db, review.latestVersionId, { companyId: review.companyId });
  const summary = version.summaryJson ?? {};
  return {
    reviewId,
    versionId: version.id,
    adapterReadiness: readObject(summary.adapterReadinessSummary),
    modelAssurance: readObject(summary.modelAssuranceSummary),
    citationValidation: readObject(version.validationJson),
  };
}

function countFindingsByCategory(engineResult: WeeklyReviewFindingEngineResult) {
  const counts: Record<string, number> = {};
  for (const finding of engineResult.findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  }
  return counts;
}

function buildSummaryJson(engineResult: WeeklyReviewFindingEngineResult, findingCounts: Record<string, number>) {
  return {
    findingCounts,
    inputCounts: engineResult.inputCounts,
    adapterReadinessSummary: engineResult.adapterReadinessSummary,
    modelAssuranceSummary: engineResult.modelAssuranceSummary,
  };
}

function buildValidatedNarration(engineResult: WeeklyReviewFindingEngineResult) {
  const citedStableIds = new Set(engineResult.citations.map((citation) => citation.findingStableId));
  const findings = engineResult.findings
    .filter((finding) => finding.validationStatus === "valid" && citedStableIds.has(finding.stableId))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.stableId.localeCompare(b.stableId));

  if (findings.length === 0) {
    return {
      status: "validation_failed" as const,
      text: "Narration unavailable: no validated cited findings were available for this review version.",
      errorCode: "narration_missing_validated_findings",
      failureReason: "Narration requires at least one validated finding with a citation",
      findingStableIds: engineResult.findings.map((finding) => finding.stableId),
    };
  }

  const lines = [
    "Executive weekly review",
    `Period: ${formatDateOnly(engineResult.periodStart)} to ${formatDateOnly(engineResult.periodEnd)}.`,
    `Validated findings: ${findings.length}.`,
    "",
    ...findings.flatMap((finding) => {
      const citations = engineResult.citations.filter((citation) => citation.findingStableId === finding.stableId);
      const citationLabels = citations.map((citation) => citation.label).filter(Boolean).join("; ");
      return [
        `- ${finding.stableId} (${finding.severity}): ${finding.title}`,
        `  ${finding.summary}`,
        `  Citation: ${citationLabels || "validated citation attached"}.`,
      ];
    }),
  ];

  return {
    status: "generated" as const,
    text: lines.join("\n"),
    findingStableIds: findings.map((finding) => finding.stableId),
  };
}

function buildNarrationValidationFailureText(engineResult: WeeklyReviewFindingEngineResult) {
  const missing = engineResult.citationValidation.materialFindingsWithoutCitations;
  const suffix = missing.length > 0 ? ` Missing citations for: ${missing.join(", ")}.` : "";
  return `Narration unavailable: material findings must be validated before executive prose is generated.${suffix}`;
}

function severityRank(severity: string) {
  if (severity === "critical") return 0;
  if (severity === "high") return 1;
  if (severity === "medium") return 2;
  if (severity === "low") return 3;
  return 4;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
