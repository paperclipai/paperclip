import { caseHandoffs, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { pendingCaseHandoffForRun } from "../heartbeat/case-handoff-lifecycle.js";

/** Server-issued semantic yield. The provider does not need a second finish call. */
export async function nativeCaseHandoffResult(db: Db, input: {
  runId: string; issueId: string;
  completionContract: { revision: string; criteria: Array<{ id: string }> };
}): Promise<PrpStructuredRunResult | null> {
  const handoff = await pendingCaseHandoffForRun(db, input.runId);
  if (!handoff || handoff.issueId !== input.issueId) return null;
  const ref = `case-handoff:${handoff.id}`;
  return {
    schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Work handed off.",
    completionClaim: { contractRevision: input.completionContract.revision, objectiveSatisfied: false,
      criteria: input.completionContract.criteria.map(criterion => ({ criterionId: criterion.id, status: "unknown", evidenceRefs: [ref] })),
      remainingWork: [{ description: "The next agent continues the same task.", blocksCompletion: true }] },
    evidence: [{ ref }], verification: [], attentionRequests: [], artifacts: [],
    continuation: { kind: "case_handoff", handoffId: handoff.id, summary: handoff.phase, idempotencyKey: `case-handoff:${handoff.id}` },
  };
}

export async function assertNativeCaseHandoffResult(db: Db, runId: string, issueId: string, result: { continuation?: unknown }) {
  const expected = await pendingCaseHandoffForRun(db, runId);
  const continuation = result.continuation as { kind?: string; handoffId?: string } | undefined;
  if (continuation?.kind === "case_handoff" && (!expected || expected.issueId !== issueId || continuation.handoffId !== expected.id)) {
    // Stop may cancel delivery after a server-issued yield was checkpointed.
    // That historical receipt still permits settling the old run, but cannot
    // deliver work or manufacture a fresh handoff.
    const [cancelled] = continuation.handoffId ? await db.select().from(caseHandoffs).where(and(
      eq(caseHandoffs.id, continuation.handoffId), eq(caseHandoffs.sourceRunId, runId), eq(caseHandoffs.issueId, issueId),
      eq(caseHandoffs.destinationKind, "agent"), eq(caseHandoffs.state, "cancelled"),
    )).limit(1) : [];
    if (cancelled) return cancelled;
    throw new Error("case_handoff continuation requires the exact persisted handoff accepted from this run");
  }
  return expected?.issueId === issueId ? expected : null;
}
