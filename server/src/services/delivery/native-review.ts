import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";
import type { DeliveryNativeReviewEvidence } from "@paperclipai/shared";

/**
 * Verified native independent review of one exact candidate revision.
 *
 * The agent-review review regime replaces the GitHub account approval with a
 * review the workers themselves record: a code-review confirmation interaction
 * carries a stored review pin (`payload.review`) naming the candidate workspace
 * and its exact revision plus the reviewer model the request expects. Its
 * resolution checks the addressed reviewer's current exact model against that
 * pin, and the interaction contract rejects the candidate's author and the
 * issue's current assignee as reviewers, so an accepted pin is proof that a
 * reviewer other than the implementation owner reviewed that revision.
 *
 * This reader is deliberately narrow and fail-closed:
 *
 * - only `accepted` review confirmations with a resolvable reviewer agent count;
 * - the pin must be well formed (workspace key, 40-hex revision, expected model)
 *   because a malformed pin proves nothing;
 * - the pinned revision must equal the revision under evaluation, so an
 *   approval of one revision never approves a later one;
 * - reviewers the caller names as not independent (the implementation owner)
 *   never count, even if a stored row somehow names them;
 * - no row, no evidence: absence blocks the review requirement, it never passes
 *   it and never falls back to a worker-declared readiness boolean.
 */

type InteractionRow = {
  id: string;
  resolvedByAgentId: string | null;
  payload: unknown;
  result: unknown;
  resolvedAt: Date | null;
};

const REVISION_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Bound on the rows one review read may return.
 *
 * The rows are filtered to the exact revision in SQL, so the bound can only be
 * reached by many reviews of that same revision, and the query is ordered newest
 * first: the relevant pin is never stranded behind rows about other revisions.
 * Reaching the bound is not a silent pick — the reader returns the newest
 * matching review, which is the one that speaks for this revision last.
 */
const NATIVE_REVIEW_READ_LIMIT = 20;

/** The stored review pin, read defensively: every field is validated, not cast. */
function readReviewPin(payload: unknown): { workspaceKey: string; revision: string; expectedModel: string } | null {
  if (!payload || typeof payload !== "object" || !("review" in payload)) return null;
  const review = payload.review;
  if (!review || typeof review !== "object" || !("candidate" in review) || !("expectedModel" in review)) return null;
  const candidate = review.candidate;
  if (!candidate || typeof candidate !== "object" || !("workspaceKey" in candidate) || !("revision" in candidate)) return null;
  const { workspaceKey, revision } = candidate;
  const { expectedModel } = review;
  if (typeof workspaceKey !== "string" || workspaceKey.trim().length === 0) return null;
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision.trim())) return null;
  if (typeof expectedModel !== "string" || expectedModel.trim().length === 0) return null;
  return { workspaceKey: workspaceKey.trim(), revision: revision.trim().toLowerCase(), expectedModel: expectedModel.trim() };
}

/**
 * A stored result that is present must agree with the accepted status. An
 * unreadable result fails closed rather than being ignored.
 */
function resultAccepts(result: unknown): boolean {
  if (result == null) return true;
  if (typeof result !== "object" || !("outcome" in result)) return false;
  return result.outcome === "accepted";
}

export async function readNativeReviewEvidence(
  db: Db,
  input: {
    companyId: string;
    /** Issues the candidate delivers: the review may name any of them. */
    issueIds: string[];
    /** Revision under evaluation. Only this exact revision counts. */
    headSha: string | null;
    /** Agents that are not independent reviewers (the implementation owner). */
    excludedReviewerAgentIds?: string[];
  },
): Promise<DeliveryNativeReviewEvidence | null> {
  const revision = input.headSha?.trim().toLowerCase() ?? null;
  const issueIds = [...new Set(input.issueIds.filter((issueId) => typeof issueId === "string" && issueId.length > 0))];
  if (!revision || !REVISION_PATTERN.test(revision) || issueIds.length === 0) return null;
  const excluded = new Set(
    (input.excludedReviewerAgentIds ?? []).filter((agentId) => typeof agentId === "string" && agentId.length > 0),
  );
  const rows: InteractionRow[] = await db
    .select({
      id: issueThreadInteractions.id,
      resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
      payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result,
      resolvedAt: issueThreadInteractions.resolvedAt,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      inArray(issueThreadInteractions.issueId, issueIds),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
      isNotNull(issueThreadInteractions.resolvedByAgentId),
      // The review pin's revision is filtered in SQL so rows about other
      // revisions cannot consume the read bound and strand the pin for the
      // revision under evaluation. Trimmed and lowercased exactly as the pin
      // reader validates it, so the predicate and the validation agree.
      sql`lower(trim(${issueThreadInteractions.payload}->'review'->'candidate'->>'revision')) = ${revision}`,
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt))
    .limit(NATIVE_REVIEW_READ_LIMIT);
  for (const row of rows) {
    const pin = readReviewPin(row.payload);
    if (!pin || pin.revision !== revision) continue;
    if (!row.resolvedByAgentId || excluded.has(row.resolvedByAgentId)) continue;
    if (!resultAccepts(row.result)) continue;
    return {
      interactionId: row.id,
      reviewerAgentId: row.resolvedByAgentId,
      reviewerModel: pin.expectedModel,
      revision: pin.revision,
      workspaceKey: pin.workspaceKey,
      reviewedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }
  return null;
}
