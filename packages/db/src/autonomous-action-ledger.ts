import { and, eq, lt, or } from "drizzle-orm";
import {
  autonomousActionRequestSchema,
  createAutonomousEffectRecord,
  decideAutonomousActionDedup,
  type AutonomousActionDedupDecision,
  type AutonomousActionRequest,
} from "@paperclipai/shared";
import type { Db } from "./client.js";
import { autonomousActionLedger } from "./schema/autonomous_action_ledger.js";

export type AutonomousConsumeResult =
  | {
      outcome: "CONSUMED" | "ALREADY_CONSUMED";
      actionId: string;
      effectKey: string;
      effectFingerprint: string;
    }
  | {
      outcome: "REJECT";
      reasonCode: "idempotency_conflict" | "action_conflict";
      actionId: string;
      effectKey: string;
      effectFingerprint: string;
    };

type LedgerRow = typeof autonomousActionLedger.$inferSelect;

function effectRecord(row: Pick<LedgerRow, "actionId" | "idempotencyKey" | "effectKey" | "effectFingerprint">) {
  return {
    actionId: row.actionId,
    idempotencyKey: row.idempotencyKey,
    effectKey: row.effectKey,
    effectFingerprint: row.effectFingerprint,
  };
}

function decisionForExisting(
  request: AutonomousActionRequest,
  row: LedgerRow,
): AutonomousActionDedupDecision {
  return decideAutonomousActionDedup(request, [effectRecord(row)]);
}

async function registerInTransaction(
  db: Db,
  companyId: string,
  request: AutonomousActionRequest,
): Promise<{ decision: AutonomousActionDedupDecision; row: LedgerRow }> {
  const parsed = autonomousActionRequestSchema.parse(request);
  const effect = createAutonomousEffectRecord(parsed);
  const scope = and(
    eq(autonomousActionLedger.companyId, companyId),
    or(
      eq(autonomousActionLedger.effectKey, effect.effectKey),
      eq(autonomousActionLedger.idempotencyKey, parsed.idempotencyKey),
      eq(autonomousActionLedger.actionId, parsed.actionId),
    ),
  );

  const existing = await db
    .select()
    .from(autonomousActionLedger)
    .where(scope)
    .for("update")
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return { decision: decisionForExisting(parsed, existing), row: existing };

  const inserted = await db
    .insert(autonomousActionLedger)
    .values({
      companyId,
      executionId: parsed.executionId,
      taskId: parsed.taskId,
      parentExecutionId: parsed.parentExecutionId,
      workerId: parsed.workerId,
      attempt: parsed.attempt,
      kind: parsed.kind,
      effectType: parsed.effectType,
      effectPayload: parsed.effectPayload,
      actionId: parsed.actionId,
      idempotencyKey: parsed.idempotencyKey,
      effectKey: effect.effectKey,
      effectFingerprint: effect.effectFingerprint,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return {
      decision: decideAutonomousActionDedup(parsed, []),
      row: inserted[0],
    };
  }

  // A concurrent transaction won one of the three unique races. Re-read under
  // the transaction so the caller gets the same deterministic dedup decision.
  const raced = await db
    .select()
    .from(autonomousActionLedger)
    .where(scope)
    .for("update")
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!raced) throw new Error("autonomous_action_ledger_conflict_without_row");
  return { decision: decisionForExisting(parsed, raced), row: raced };
}

export async function registerAutonomousAction(
  db: Db,
  companyId: string,
  request: AutonomousActionRequest,
): Promise<AutonomousActionDedupDecision> {
  return db.transaction(async (tx) => {
    const result = await registerInTransaction(tx as unknown as Db, companyId, request);
    return result.decision;
  });
}

export async function consumeAutonomousActionOnce(
  db: Db,
  companyId: string,
  request: AutonomousActionRequest,
): Promise<AutonomousConsumeResult> {
  return db.transaction(async (tx) => {
    const { decision, row } = await registerInTransaction(tx as unknown as Db, companyId, request);
    if (decision.outcome === "REJECT") {
      if (decision.reasonCode !== "idempotency_conflict" && decision.reasonCode !== "action_conflict") {
        throw new Error(`autonomous_action_ledger_unexpected_rejection:${decision.reasonCode}`);
      }
      return {
        outcome: "REJECT",
        reasonCode: decision.reasonCode,
        actionId: row.actionId,
        effectKey: decision.effectKey,
        effectFingerprint: decision.effectFingerprint,
      };
    }

    const claimed = await tx
      .update(autonomousActionLedger)
      .set({ status: "claimed", updatedAt: new Date() })
      .where(
        and(
          eq(autonomousActionLedger.id, row.id),
          or(
            eq(autonomousActionLedger.status, "accepted"),
            and(
              eq(autonomousActionLedger.status, "claimed"),
              lt(autonomousActionLedger.updatedAt, new Date(Date.now() - 5 * 60_000)),
            ),
          ),
        ),
      )
      .returning({ actionId: autonomousActionLedger.actionId });
    return {
      outcome: claimed[0] ? "CONSUMED" : "ALREADY_CONSUMED",
      actionId: row.actionId,
      effectKey: decision.effectKey,
      effectFingerprint: decision.effectFingerprint,
    };
  });
}

/** Release an admission reservation when policy denied before dispatch. */
export async function releaseAutonomousActionReservation(
  db: Db,
  companyId: string,
  actionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(autonomousActionLedger)
      .where(and(
        eq(autonomousActionLedger.companyId, companyId),
        eq(autonomousActionLedger.actionId, actionId),
        eq(autonomousActionLedger.status, "accepted"),
      ))
      .returning({ actionId: autonomousActionLedger.actionId });
    return rows.length > 0;
  });
}

/** Mark the remote handoff boundary; stale recovery must not replay it. */
export async function markAutonomousActionDispatched(
  db: Db,
  companyId: string,
  actionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(autonomousActionLedger)
      .set({ status: "dispatched", updatedAt: new Date() })
      .where(and(
        eq(autonomousActionLedger.companyId, companyId),
        eq(autonomousActionLedger.actionId, actionId),
        eq(autonomousActionLedger.status, "claimed"),
      ))
      .returning({ actionId: autonomousActionLedger.actionId });
    return rows.length > 0;
  });
}

/** Finalize a claimed effect after the adapter has returned successfully. */
export async function completeAutonomousAction(
  db: Db,
  companyId: string,
  actionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(autonomousActionLedger)
      .set({ status: "consumed", consumedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(autonomousActionLedger.companyId, companyId),
        eq(autonomousActionLedger.actionId, actionId),
        or(
          eq(autonomousActionLedger.status, "claimed"),
          eq(autonomousActionLedger.status, "dispatched"),
          eq(autonomousActionLedger.status, "consumed"),
        ),
      ))
      .returning({ actionId: autonomousActionLedger.actionId });
    return rows.length > 0;
  });
}
