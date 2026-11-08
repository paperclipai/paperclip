import { and, eq, inArray, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { confirmOwnerGoneSchema } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, OwnableKind } from "./ownership-registry.js";

/** Recovery action cause: a stuck record whose owner Paperclip cannot judge. */
export const OWNER_UNPROVABLE_CAUSE = "ownership_owner_unprovable";
/** Lease metadata key the board's confirmation writes; the owner proof reads it as gone. */
export const OWNER_GONE_ATTESTATION_KEY = "ownerGoneAttestation";

/** Unprovable because the record names no usable owner: saved before owners were recorded. */
export const LEGACY_OWNER_REASONS: ReadonlySet<string> = new Set(["no_owner_stamp", "process_space_unrecorded", "missing_identity"]);
const LEGACY_REASONS = LEGACY_OWNER_REASONS;

const fingerprint = (kind: string, recordId: string) => `ownership-owner:${kind}:${recordId}`;
const changed = () => conflict("This record changed since recovery asked. Refresh the task and inspect its run.",
  { code: "ownership_owner_attestation_stale" });

/** Idempotent. Asks the board on the record's task; a record with no task keeps its other recovery path. */
export function requestOwnerGoneConfirmation(kindId: string) {
  return async (db: Db, record: InProgressRecord, context: { now: Date; proof: OwnerProof }): Promise<void> => {
    if (!LEGACY_REASONS.has(context.proof.reason) || !record.issueId || !record.companyId) return;
    const recordUpdatedAt = record.updatedAt?.toISOString() ?? null;
    // A record that changed while the board was asked: the open request names its current version,
    // so a confirmation always binds to what the board can see now.
    if (recordUpdatedAt) {
      await db.update(issueRecoveryActions)
        .set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ recordUpdatedAt })}::jsonb`, updatedAt: context.now })
        .where(and(eq(issueRecoveryActions.companyId, record.companyId), eq(issueRecoveryActions.sourceIssueId, record.issueId),
          eq(issueRecoveryActions.cause, OWNER_UNPROVABLE_CAUSE), eq(issueRecoveryActions.fingerprint, fingerprint(kindId, record.recordId)),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`${issueRecoveryActions.evidence}->>'recordUpdatedAt' is distinct from ${recordUpdatedAt}`));
    }
    await db.insert(issueRecoveryActions).values({
      companyId: record.companyId, sourceIssueId: record.issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", cause: OWNER_UNPROVABLE_CAUSE,
      fingerprint: fingerprint(kindId, record.recordId), attemptCount: 1,
      // The record version the board is asked about: a record-version attestation applies only while
      // the record is unchanged, so it can never release an owner that took the record over since.
      evidence: { kind: kindId, recordId: record.recordId, runId: record.runId, proof: context.proof.reason,
        recordUpdatedAt },
      nextAction: "A resource from this task's earlier run was recorded before Paperclip stored which server held it, "
        + "so Paperclip cannot verify that the server stopped. Confirm that the previous server process has stopped "
        + "(for example, its container was replaced), and recovery releases the resource.",
    }).onConflictDoNothing();
  };
}

/**
 * The generic attestation for a kind whose record carries no field to hold it. The board's
 * confirmation stays on the resolved recovery action, bound to the record version recovery asked
 * about; the reconciler reads it back (`recordVersionAttestations`). A record with no version
 * cannot be bound, so it keeps its other recovery path.
 */
export async function attestOwnerGoneByRecordVersion(tx: Db, target: { companyId: string; recordId: string;
  requestedVersion: string | null }, lockVersion: (tx: Db, target: { companyId: string; recordId: string }) => Promise<Date | null>,
): Promise<"attested" | "released" | "changed"> {
  const version = await lockVersion(tx, target);
  if (!version) return "released";
  // The record changed since the board was asked: the confirmation would never apply, so refuse it.
  return target.requestedVersion === version.toISOString() ? "attested" : "changed";
}

/**
 * Board confirmations, by record id, for records of `kindId` whose owner is still unprovable for a
 * legacy reason and whose version still equals the version the board confirmed. Only those
 * records are read, so a kind with nothing stuck issues no statement.
 */
export async function recordVersionAttestations(db: Db, kindId: string,
  candidates: readonly { recordId: string; companyId: string | null; updatedAt: Date | null }[]): Promise<Set<string>> {
  const bound = candidates.filter(record => record.companyId && record.updatedAt);
  if (!bound.length) return new Set();
  const rows = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.cause, OWNER_UNPROVABLE_CAUSE), eq(issueRecoveryActions.status, "resolved"),
    inArray(issueRecoveryActions.companyId, [...new Set(bound.map(record => record.companyId!))]),
    inArray(issueRecoveryActions.fingerprint, bound.map(record => fingerprint(kindId, record.recordId))),
    sql`${issueRecoveryActions.evidence} ? 'ownerGone'`));
  // A record can have several confirmations (one per version the board confirmed); any one of
  // them that names the current version applies.
  const confirmed = new Set<string>();
  for (const { evidence } of rows) {
    if (typeof evidence?.recordId === "string" && typeof evidence.recordUpdatedAt === "string")
      confirmed.add(`${evidence.recordId}|${evidence.recordUpdatedAt}`);
  }
  return new Set(bound.filter(record => confirmed.has(`${record.recordId}|${record.updatedAt!.toISOString()}`))
    .map(record => record.recordId));
}

/** Board attestation for exactly the record recovery asked about. Recovery then settles it on its normal path. */
export async function confirmOwnerGone(input: {
  db: Db; kinds: readonly OwnableKind[]; companyId: string; issueId: string;
  actionId: string; recordId: string; stopEvidence: string; actorId: string; recordVersion?: string;
}) {
  const confirmation = confirmOwnerGoneSchema.parse({
    actionId: input.actionId, recordId: input.recordId, stopEvidence: input.stopEvidence,
    ...(input.recordVersion === undefined ? {} : { recordVersion: input.recordVersion }),
  });
  const committed = await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId))).for("update");
    const kind = input.kinds.find(candidate => candidate.id === action?.evidence?.kind);
    // A request names the record version the board was shown; the confirmation must be for that
    // same version, so a form opened before the request was refreshed cannot approve a newer one.
    const requestedVersion = typeof action?.evidence?.recordUpdatedAt === "string" ? action.evidence.recordUpdatedAt : null;
    if (requestedVersion && confirmation.recordVersion !== requestedVersion) throw changed();
    if (!action || !kind?.attestOwnerGone || action.cause !== OWNER_UNPROVABLE_CAUSE || action.ownerType !== "board"
      || !["active", "escalated"].includes(action.status) || action.evidence?.recordId !== input.recordId) throw changed();
    const now = new Date();
    const proof = { actorId: input.actorId, stopEvidence: confirmation.stopEvidence, confirmedAt: now.toISOString() };
    const attestation = await kind.attestOwnerGone(tx, { companyId: input.companyId, recordId: input.recordId,
      requestedVersion }, proof);
    if (attestation === "changed") throw changed();
    // Released by another path: close the request; nothing remains to attest.
    const released = attestation === "released";
    // An unprovable record is not watched, so wake the reconciler to settle it now (work intent
    // before the write it announces).
    if (!released) await notifyDeliveryWork(tx, DELIVERY_QUEUES.ownershipInvariantReport,
      JSON.stringify({ companyId: input.companyId, runId: typeof action.evidence?.runId === "string" ? action.evidence.runId : null }));
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      evidence: { ...action.evidence, ...(released ? { ownerGoneNotNeeded: proof } : { ownerGone: proof }) },
      nextAction: released ? "The resource was already released. No confirmation was needed."
        : "The previous server was confirmed stopped. Recovery releases the resource.",
    }).where(eq(issueRecoveryActions.id, action.id));
    const publication = await persistActivity(tx, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.ownership_owner_gone_confirmed", entityType: "issue", entityId: input.issueId,
      runId: typeof action.evidence?.runId === "string" ? action.evidence.runId : undefined,
      details: { recoveryActionId: input.actionId, kind: kind.id, recordId: input.recordId, outcome: attestation, ...proof } });
    return { publication, released };
  });
  publishActivity(committed.publication.publication);
  return { recordId: input.recordId, status: committed.released ? "released" as const : "queued" as const };
}
