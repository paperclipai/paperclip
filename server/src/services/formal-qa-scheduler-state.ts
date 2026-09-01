import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaSchedulerStates } from "@paperclipai/db";

export const FORMAL_QA_STAGE = {
  discovery: "github_discovery",
  issuance: "github_issuance",
  reviewQueue: "review_queue",
} as const;

export function formalQaSchedulerStateService(db: Db) {
  const record = async (input: {
    companyId: string;
    stage: string;
    subjectId: string;
    cursor?: number;
    delayMs: number;
    failed: boolean;
  }) => {
    const nextEligibleAt = new Date(Date.now() + Math.max(0, input.delayMs));
    await db.insert(formalQaSchedulerStates).values({
      companyId: input.companyId,
      stage: input.stage,
      subjectId: input.subjectId,
      cursor: input.cursor ?? 1,
      failureCount: input.failed ? 1 : 0,
      nextEligibleAt,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [formalQaSchedulerStates.stage, formalQaSchedulerStates.subjectId],
      set: {
        companyId: input.companyId,
        cursor: input.cursor ?? 1,
        failureCount: input.failed ? sql`${formalQaSchedulerStates.failureCount} + 1` : 0,
        nextEligibleAt,
        updatedAt: new Date(),
      },
    });
  };

  return {
    record,
    clear: async (stage: string, subjectId: string) => {
      await db.delete(formalQaSchedulerStates).where(and(
        eq(formalQaSchedulerStates.stage, stage),
        eq(formalQaSchedulerStates.subjectId, subjectId),
      ));
    },
  };
}
