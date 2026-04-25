import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { prReviewStates, reviewerFamilyLog, type PrReviewState } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

export type ReviewPosition = "approved" | "changes_requested" | "commented" | null;

export interface AdversarialReviewResult {
  state: PrReviewState;
  juryTriggered: boolean;
  reviewComplete: boolean;
}

export async function createReviewState(
  db: Db,
  companyId: string,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  builderAgentId: string,
  breakerAgentId?: string,
): Promise<PrReviewState> {
  const existing = await db.query.prReviewStates.findFirst({
    where: and(
      eq(prReviewStates.repositoryFullName, repositoryFullName),
      eq(prReviewStates.prNumber, prNumber),
      eq(prReviewStates.headSha, headSha),
    ),
  });

  if (existing) {
    logger.debug({ repositoryFullName, prNumber, headSha }, "Review state already exists");
    return existing;
  }

  const [state] = await db
    .insert(prReviewStates)
    .values({
      companyId,
      repositoryFullName,
      prNumber,
      headSha,
      builderAgentId,
      breakerAgentId: breakerAgentId || null,
      round: 1,
      juryInvoked: false,
      reviewComplete: false,
    })
    .returning();

  logger.info({ stateId: state.id, repositoryFullName, prNumber }, "Created adversarial review state");
  return state;
}

export async function getReviewState(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
): Promise<PrReviewState | null> {
  const state = await db.query.prReviewStates.findFirst({
    where: and(
      eq(prReviewStates.repositoryFullName, repositoryFullName),
      eq(prReviewStates.prNumber, prNumber),
      eq(prReviewStates.headSha, headSha),
    ),
  });
  return state || null;
}

export async function recordBuilderPosition(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  position: ReviewPosition,
): Promise<PrReviewState> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    throw new Error(`Review state not found for ${repositoryFullName} #${prNumber} at ${headSha}`);
  }

  await db
    .update(prReviewStates)
    .set({
      builderPosition: position,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(prReviewStates.id, state.id));

  const updated = await getReviewState(db, repositoryFullName, prNumber, headSha);
  return updated!;
}

export async function recordBreakerPosition(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  position: ReviewPosition,
  breakerAgentId: string,
  breakerFamily: string,
): Promise<AdversarialReviewResult> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    throw new Error(`Review state not found for ${repositoryFullName} #${prNumber} at ${headSha}`);
  }

  const result = await db.execute(sql`
    SELECT advance_review_round(
      ${repositoryFullName},
      ${prNumber},
      ${headSha},
      ${state.builderPosition},
      ${position}
    ) as state
  `);
  const row = (result as unknown as { rows: { state: PrReviewState }[] }).rows[0];
  if (!row?.state) {
    throw new Error(`advance_review_round failed for ${repositoryFullName}#${prNumber} at ${headSha}`);
  }
  const updatedState = row.state;

  await recordReviewerParticipation(
    db,
    updatedState.id,
    updatedState.round,
    breakerAgentId,
    breakerFamily,
    "breaker",
  );

  return {
    state: updatedState,
    juryTriggered: updatedState.juryInvoked,
    reviewComplete: updatedState.reviewComplete,
  };
}

export async function invokeJury(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
): Promise<PrReviewState> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    throw new Error(`Review state not found for ${repositoryFullName} #${prNumber} at ${headSha}`);
  }

  await db
    .update(prReviewStates)
    .set({
      juryInvoked: true,
      juryTriggeredAt: new Date(),
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(prReviewStates.id, state.id));

  const updated = await getReviewState(db, repositoryFullName, prNumber, headSha);
  logger.info({ stateId: state.id, repositoryFullName, prNumber }, "Jury invoked for adversarial review");
  return updated!;
}

export async function completeReview(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  verdict?: string,
): Promise<PrReviewState> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    throw new Error(`Review state not found for ${repositoryFullName} #${prNumber} at ${headSha}`);
  }

  await db
    .update(prReviewStates)
    .set({
      reviewComplete: true,
      reviewCompleteAt: new Date(),
      juryVerdict: verdict || null,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(prReviewStates.id, state.id));

  const updated = await getReviewState(db, repositoryFullName, prNumber, headSha);
  logger.info({ stateId: state.id, repositoryFullName, prNumber, verdict }, "Adversarial review completed");
  return updated!;
}

async function recordReviewerParticipation(
  db: Db,
  prReviewStateId: string,
  round: number,
  reviewerAgentId: string,
  reviewerFamily: string,
  reviewType: string,
): Promise<void> {
  await db
    .insert(reviewerFamilyLog)
    .values({
      prReviewStateId,
      round,
      reviewerAgentId,
      reviewerFamily,
      reviewType,
    });
}

export async function getNextBreakerCandidate(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
): Promise<string | null> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    return null;
  }

  const usedFamiliesResult = await db
    .select({ families: reviewerFamilyLog.reviewerFamily })
    .from(reviewerFamilyLog)
    .where(eq(reviewerFamilyLog.prReviewStateId, state.id));

  const usedFamilies = usedFamiliesResult.map((r) => r.families);

  const candidates = await db.query.agentRoleCandidates.findMany({
    where: (arc, { eq, and, ne }) =>
      and(
        eq(arc.role, "qa_reviewer"),
        eq(arc.isSaturated, false),
      ),
  });

  const available = candidates.filter((c) => !usedFamilies.includes(c.provider));
  if (available.length === 0) {
    return null;
  }

  available.sort((a, b) => b.qualityRank - a.qualityRank);
  return available[0].id || null;
}

export async function isFamilyExhausted(
  db: Db,
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  reviewerFamily: string,
): Promise<boolean> {
  const state = await getReviewState(db, repositoryFullName, prNumber, headSha);
  if (!state) {
    return false;
  }

  const usedFamiliesResult = await db
    .select({ families: reviewerFamilyLog.reviewerFamily })
    .from(reviewerFamilyLog)
    .where(eq(reviewerFamilyLog.prReviewStateId, state.id));

  const usedFamilies = usedFamiliesResult.map((r) => r.families);
  return usedFamilies.includes(reviewerFamily);
}
