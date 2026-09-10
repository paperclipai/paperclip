import { and, desc, eq, inArray } from "drizzle-orm";
import { deliveryFindings, deliveryUnits, type Db } from "@paperclipai/db";
import type { GreptileFinding } from "./greptile.js";

/**
 * Persisted review findings.
 *
 * One store owns how a governed read becomes durable evidence so the reconcile
 * path, the merge path and the operator-facing review read all present the same
 * findings, states and head provenance.
 *
 * Findings are generation-scoped rows: `(unit, source, external_id,
 * candidate_generation)` is the identity of one reported finding for one
 * candidate, so the same provider finding reappearing on a later candidate
 * never overwrites the earlier candidate's record. Older rows stay as history.
 */

const OPEN_FINDING_STATE = "open" as const;

/**
 * Record the findings a governed read observed for `headSha`.
 *
 * Rules, in precedence order:
 *
 * 1. A human `disputed` disposition holds. A dispute blocks and is never
 *    cleared by the provider's own flag or by a later read. A dispute is about
 *    the defect, not one revision: when the same finding reappears on a new
 *    candidate it is carried onto that candidate's row.
 * 2. A finding the provider reports as addressed is recorded
 *    `already_addressed` and never reopens while it stays flagged.
 * 3. Any other finding the provider still reports reopens, because it is
 *    reported on the snapshot just read.
 * 4. An open finding that this snapshot no longer reports goes `stale` — it
 *    never silently clears, and dispositions are never erased by an empty
 *    snapshot.
 *
 * The whole observation — fence check, upserts and the stale sweep — runs in
 * one transaction that takes the unit row lock first. Candidate replacement
 * increments `candidate_generation` on that same row, so it either commits
 * before this read (and the snapshot is discarded) or waits until this write is
 * durable. An unlocked read followed by writes is not a fence: the candidate
 * could be replaced in between and the snapshot would land as evidence for a
 * candidate it never described.
 */
export async function recordObservedFindings(
  db: Db,
  input: {
    companyId: string;
    unitId: string;
    /**
     * Candidate generation the snapshot was read for. The write is fenced: a
     * snapshot that arrives after the candidate identity moved on is discarded
     * rather than recorded as evidence for the new candidate.
     */
    candidateGeneration: number;
    /** Revision the snapshot belongs to; `null` skips the stale sweep. */
    headSha: string | null;
    findings: GreptileFinding[];
  },
): Promise<{ recorded: boolean }> {
  return await db.transaction(async (tx) => {
    // Lock the unit row before anything is written. The replacement statement
    // (`registerCandidate`) increments `candidate_generation` on this row, so
    // holding the row lock makes the fence and the write one atomic unit:
    // either the replacement committed first (the generation below differs and
    // nothing is written) or it waits for this snapshot to be durable.
    const [unit] = await tx
      .select({ candidateGeneration: deliveryUnits.candidateGeneration })
      .from(deliveryUnits)
      .where(and(eq(deliveryUnits.companyId, input.companyId), eq(deliveryUnits.id, input.unitId)))
      .limit(1)
      .for("update");
    if (!unit || unit.candidateGeneration !== input.candidateGeneration) return { recorded: false };
    const now = new Date();
    const reportedIds: string[] = [];
    for (const finding of input.findings) {
      reportedIds.push(finding.externalId);
      // Identity is generation-scoped: a finding the provider reports again on
      // a later candidate creates its own row instead of overwriting the
      // earlier candidate's record.
      const [existing] = await tx
        .select({ id: deliveryFindings.id, state: deliveryFindings.state })
        .from(deliveryFindings)
        .where(and(
          eq(deliveryFindings.companyId, input.companyId),
          eq(deliveryFindings.unitId, input.unitId),
          eq(deliveryFindings.source, "greptile"),
          eq(deliveryFindings.externalId, finding.externalId),
          eq(deliveryFindings.candidateGeneration, input.candidateGeneration),
        ))
        .limit(1);
      const providerAddressed = finding.addressed === true;
      const providerState: (typeof deliveryFindings.$inferSelect)["state"] = providerAddressed
        ? "already_addressed"
        : OPEN_FINDING_STATE;
      const values = {
        severity: finding.severity,
        title: finding.title,
        body: finding.body,
        filePath: finding.filePath,
        line: finding.line,
        url: finding.url,
        headSha: input.headSha,
        candidateGeneration: input.candidateGeneration,
        lastSeenAt: now,
        updatedAt: now,
      };
      if (existing) {
        // A human `disputed` disposition holds: a dispute blocks and is never
        // cleared by the provider's own flag or by a later read, so the
        // disposition is preserved verbatim while the finding keeps being
        // reported on this candidate.
        const nextState = existing.state === "disputed" ? "disputed" : providerState;
        await tx.update(deliveryFindings).set({ ...values, state: nextState }).where(eq(deliveryFindings.id, existing.id));
        continue;
      }
      // A dispute is a recorded human decision about the defect, not about one
      // revision: when the same finding reappears on a new candidate, the
      // dispute is carried onto the new generation's row rather than silently
      // reset to the provider's own state.
      const [priorDispute] = await tx
        .select({
          dispositionExplanation: deliveryFindings.dispositionExplanation,
          dispositionActorType: deliveryFindings.dispositionActorType,
          dispositionActorId: deliveryFindings.dispositionActorId,
          dispositionAt: deliveryFindings.dispositionAt,
        })
        .from(deliveryFindings)
        .where(and(
          eq(deliveryFindings.companyId, input.companyId),
          eq(deliveryFindings.unitId, input.unitId),
          eq(deliveryFindings.source, "greptile"),
          eq(deliveryFindings.externalId, finding.externalId),
          eq(deliveryFindings.state, "disputed"),
        ))
        .orderBy(desc(deliveryFindings.candidateGeneration), desc(deliveryFindings.lastSeenAt))
        .limit(1);
      await tx
        .insert(deliveryFindings)
        .values({
          companyId: input.companyId,
          unitId: input.unitId,
          source: "greptile",
          externalId: finding.externalId,
          ...values,
          state: priorDispute ? "disputed" : providerState,
          ...(priorDispute
            ? {
              disposition: "disputed" as const,
              dispositionExplanation: priorDispute.dispositionExplanation,
              dispositionActorType: priorDispute.dispositionActorType,
              dispositionActorId: priorDispute.dispositionActorId,
              dispositionAt: priorDispute.dispositionAt,
            }
            : {}),
          firstSeenAt: now,
        })
        .onConflictDoNothing();
    }
    if (input.headSha === null) return { recorded: true };
    // The sweep is part of the same locked unit of work: it can only ever
    // rewrite the generation this snapshot described.
    const openRows = await tx
      .select({ id: deliveryFindings.id, externalId: deliveryFindings.externalId })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, input.unitId),
        // Only the current generation is swept: a finding of a replaced
        // candidate is history already and must not be rewritten by a snapshot
        // that never described that candidate.
        eq(deliveryFindings.candidateGeneration, input.candidateGeneration),
        eq(deliveryFindings.state, OPEN_FINDING_STATE),
      ));
    const staleIds = openRows
      .filter((row) => !reportedIds.includes(row.externalId))
      .map((row) => row.id);
    if (staleIds.length > 0) {
      await tx
        .update(deliveryFindings)
        .set({ state: "stale", updatedAt: now })
        .where(inArray(deliveryFindings.id, staleIds));
    }
    return { recorded: true };
  });
}
