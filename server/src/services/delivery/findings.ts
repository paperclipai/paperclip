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
 * 2. GitHub's own review-thread record is the host-side authority, but only for
 *    the revision it belongs to. A finding whose exact thread GitHub resolved
 *    on the observed head — or on a revision that head provably contains — is
 *    recorded `already_addressed` and never reopens while that record stands,
 *    including when the provider still reports the finding unaddressed.
 * 3. A resolution on a revision the observed head does not carry clears
 *    nothing: the finding stays open, the resolution is recorded as
 *    provenance so an operator can see exactly which revision it belongs to,
 *    and a later read of the same stale thread never promotes it to
 *    current-head evidence. A thread that is unresolved, ambiguous, outdated
 *    without resolution, or not returned at all is likewise not addressed:
 *    a missing thread is a coverage gap, never resolution by omission.
 * 4. Otherwise the provider's own `addressed` flag records
 *    `already_addressed` while it stays set.
 * 5. Any other finding the provider still reports reopens, because it is
 *    reported on the snapshot just read.
 * 6. An open finding that this snapshot no longer reports goes `stale` — it
 *    never silently clears, and dispositions are never erased by an empty
 *    snapshot.
 *
 * Every state is re-derived from the observation that describes it. A
 * resolution therefore reads as resolved only for a head an observation proved
 * it on: when the head moves and the new observation no longer carries the
 * resolution, the finding blocks again instead of keeping stale evidence.
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
        .select({
          id: deliveryFindings.id,
          state: deliveryFindings.state,
          dispositionActorType: deliveryFindings.dispositionActorType,
        })
        .from(deliveryFindings)
        .where(and(
          eq(deliveryFindings.companyId, input.companyId),
          eq(deliveryFindings.unitId, input.unitId),
          eq(deliveryFindings.source, "greptile"),
          eq(deliveryFindings.externalId, finding.externalId),
          eq(deliveryFindings.candidateGeneration, input.candidateGeneration),
        ))
        .limit(1);
      // GitHub's own resolution record for the exact thread that carries this
      // finding identity. It clears the finding only for the revision it
      // belongs to: the head under this observation, or a revision that head
      // provably contains. A resolution on a superseded or unprovable revision
      // stays visible as provenance and clears nothing.
      const hostResolution = finding.reviewThread?.resolved === true ? finding.reviewThread : null;
      const clearedByHost = hostResolution !== null && hostResolution.currentHead;
      const observedState: (typeof deliveryFindings.$inferSelect)["state"] =
        clearedByHost || finding.addressed === true
          ? "already_addressed"
          : OPEN_FINDING_STATE;
      // The recorded reason for a system-derived state, so an operator can see
      // which revision a resolution belongs to and whether it applies here.
      const resolutionFields = hostResolution === null
        ? {}
        : hostResolution.currentHead
          ? {
            disposition: "already_addressed" as const,
            dispositionExplanation: `GitHub review thread ${hostResolution.id} is resolved on ${hostResolution.commitSha ?? input.headSha ?? "the reviewed revision"}`,
            dispositionActorType: "system" as const,
            dispositionActorId: "github-review-thread",
            dispositionAt: now,
          }
          : {
            disposition: null,
            dispositionExplanation: `GitHub review thread ${hostResolution.id} is resolved on ${hostResolution.commitSha ?? "an unpublished revision"}, which the current head does not carry`,
            dispositionActorType: "system" as const,
            dispositionActorId: "github-review-thread",
            dispositionAt: now,
          };
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
        if (existing.state === "disputed") {
          await tx.update(deliveryFindings).set({ ...values, state: "disputed" }).where(eq(deliveryFindings.id, existing.id));
          continue;
        }
        // System-recorded provenance is re-derived with the state it explains:
        // restated while the host still reports the resolution, and cleared
        // when the observation no longer carries it, so a re-opened finding
        // never keeps a resolved explanation.
        await tx.update(deliveryFindings).set({
          ...values,
          state: observedState,
          ...(hostResolution
            ? resolutionFields
            : existing.dispositionActorType === "system"
              ? {
                disposition: null,
                dispositionExplanation: null,
                dispositionActorType: null,
                dispositionActorId: null,
                dispositionAt: null,
              }
              : {}),
        }).where(eq(deliveryFindings.id, existing.id));
        continue;
      }
      // A dispute is a recorded human decision about the defect, not about one
      // revision: when the same finding reappears on a new candidate, the
      // dispute is carried onto the new generation's row rather than silently
      // reset to the provider's own state. Host resolution is recorded the same
      // way it is on an existing row, so the new candidate's row states why it
      // reads as addressed.
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
          state: priorDispute ? "disputed" : observedState,
          ...(priorDispute
            ? {
              disposition: "disputed" as const,
              dispositionExplanation: priorDispute.dispositionExplanation,
              dispositionActorType: priorDispute.dispositionActorType,
              dispositionActorId: priorDispute.dispositionActorId,
              dispositionAt: priorDispute.dispositionAt,
            }
            : resolutionFields),
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
