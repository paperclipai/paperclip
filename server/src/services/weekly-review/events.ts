import type { Db } from "@paperclipai/db";
import { weeklyReviewEvents } from "@paperclipai/db";
import type { WeeklyReviewEventStatus, WeeklyReviewEventType } from "@paperclipai/shared";
import {
  computeDebugEventExpiresAt,
  redactWeeklyReviewDebugMetadata,
  redactWeeklyReviewDiagnosticString,
} from "./retention.js";

export interface RecordWeeklyReviewEventInput {
  companyId: string;
  reviewId?: string | null;
  versionId?: string | null;
  eventType: WeeklyReviewEventType;
  status: WeeklyReviewEventStatus;
  actorUserId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  sourceWindowStart?: Date | null;
  sourceWindowEnd?: Date | null;
  inputCounts?: Record<string, number> | null;
  findingCounts?: Record<string, number> | null;
  citationValidation?: Record<string, unknown> | null;
  adapterReadinessSummary?: Record<string, unknown> | null;
  modelAssuranceSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  failureReason?: string | null;
  debugMetadata?: Record<string, unknown> | null;
}

export function weeklyReviewEventService(db: Db) {
  return {
    async record(input: RecordWeeklyReviewEventInput) {
      const isFailure = input.status === "failed" || input.eventType.endsWith("_failed");
      const status: WeeklyReviewEventStatus = isFailure ? "failed" : input.status;
      const [row] = await db
        .insert(weeklyReviewEvents)
        .values({
          companyId: input.companyId,
          reviewId: input.reviewId ?? null,
          versionId: input.versionId ?? null,
          eventType: input.eventType,
          status,
          actorUserId: input.actorUserId ?? null,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
          sourceWindowStart: input.sourceWindowStart ?? null,
          sourceWindowEnd: input.sourceWindowEnd ?? null,
          inputCountsJson: input.inputCounts ?? null,
          findingCountsJson: input.findingCounts ?? null,
          citationValidationJson: input.citationValidation ?? null,
          adapterReadinessSummaryJson: input.adapterReadinessSummary ?? null,
          modelAssuranceSummaryJson: input.modelAssuranceSummary ?? null,
          errorCode: input.errorCode ?? null,
          failureReason: isFailure ? redactWeeklyReviewDiagnosticString(input.failureReason) : null,
          debugMetadataJson: isFailure ? redactWeeklyReviewDebugMetadata(input.debugMetadata) : null,
          expiresAt: isFailure ? computeDebugEventExpiresAt() : null,
        })
        .returning();

      return row;
    },
  };
}
