import { and, eq } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { confirmOwnerGoneSchema } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, OwnableKind } from "./ownership-registry.js";

/** Recovery action cause: a stuck record whose owner Paperclip cannot judge. */
export const OWNER_UNPROVABLE_CAUSE = "ownership_owner_unprovable";
/** Lease metadata key the board's confirmation writes; the owner proof reads it as gone. */
export const OWNER_GONE_ATTESTATION_KEY = "ownerGoneAttestation";

/** Unprovable because the record names no usable owner: saved before owners were recorded. */
const LEGACY_REASONS = new Set(["no_owner_stamp", "process_space_unrecorded", "missing_identity"]);

const fingerprint = (kind: string, recordId: string) => `ownership-owner:${kind}:${recordId}`;
const changed = () => conflict("This record changed since recovery asked. Refresh the task and inspect its run.",
  { code: "ownership_owner_attestation_stale" });

/** Idempotent. Asks the board on the record's task; a record with no task keeps its other recovery path. */
export function requestOwnerGoneConfirmation(kindId: string) {
  return async (db: Db, record: InProgressRecord, context: { now: Date; proof: OwnerProof }): Promise<void> => {
    if (!LEGACY_REASONS.has(context.proof.reason) || !record.issueId || !record.companyId) return;
    await db.insert(issueRecoveryActions).values({
      companyId: record.companyId, sourceIssueId: record.issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", cause: OWNER_UNPROVABLE_CAUSE,
      fingerprint: fingerprint(kindId, record.recordId), attemptCount: 1,
      evidence: { kind: kindId, recordId: record.recordId, runId: record.runId, proof: context.proof.reason },
      nextAction: "A resource from this task's earlier run was recorded before Paperclip stored which server held it, "
        + "so Paperclip cannot verify that the server stopped. Confirm that the previous server process has stopped "
        + "(for example, its container was replaced), and recovery releases the resource.",
    }).onConflictDoNothing();
  };
}

/** Board attestation for exactly the record recovery asked about. Recovery then settles it on its normal path. */
export async function confirmOwnerGone(input: {
  db: Db; kinds: readonly OwnableKind[]; companyId: string; issueId: string;
  actionId: string; recordId: string; stopEvidence: string; actorId: string;
}) {
  const confirmation = confirmOwnerGoneSchema.parse({
    actionId: input.actionId, recordId: input.recordId, stopEvidence: input.stopEvidence,
  });
  const committed = await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId))).for("update");
    const kind = input.kinds.find(candidate => candidate.id === action?.evidence?.kind);
    if (!action || !kind?.attestOwnerGone || action.cause !== OWNER_UNPROVABLE_CAUSE || action.ownerType !== "board"
      || !["active", "escalated"].includes(action.status) || action.evidence?.recordId !== input.recordId) throw changed();
    const now = new Date();
    const proof = { actorId: input.actorId, stopEvidence: confirmation.stopEvidence, confirmedAt: now.toISOString() };
    if (!(await kind.attestOwnerGone(tx, { companyId: input.companyId, recordId: input.recordId }, proof))) throw changed();
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      evidence: { ...action.evidence, ownerGone: proof },
      nextAction: "The previous server was confirmed stopped. Recovery releases the resource.",
    }).where(eq(issueRecoveryActions.id, action.id));
    const publication = await persistActivity(tx, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.ownership_owner_gone_confirmed", entityType: "issue", entityId: input.issueId,
      runId: typeof action.evidence?.runId === "string" ? action.evidence.runId : undefined,
      details: { recoveryActionId: input.actionId, kind: kind.id, recordId: input.recordId, ...proof } });
    return { publication };
  });
  publishActivity(committed.publication.publication);
  return { recordId: input.recordId, status: "queued" as const };
}
