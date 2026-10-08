import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./index.js";
import { companies } from "./schema/companies.js";
import { autonomousActionLedger } from "./schema/autonomous_action_ledger.js";
import {
  consumeAutonomousActionOnce,
  completeAutonomousAction,
  markAutonomousActionDispatched,
  registerAutonomousAction,
} from "./autonomous-action-ledger.js";
import type { AutonomousActionRequest } from "@paperclipai/shared";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const request: AutonomousActionRequest = {
  actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
  idempotencyKey: "autonomous-idempotency/run-1/task-1/1/WAKEUP",
  executionId: "run-1",
  taskId: "task-1",
  parentExecutionId: null,
  workerId: "worker-1",
  attempt: 1,
  kind: "WAKEUP",
  effectType: "wakeup",
  effectPayload: { target: "task-1" },
};

function uniqueIndexNames() {
  return getTableConfig(autonomousActionLedger).indexes
    .filter((index) => index.config.unique)
    .map((index) => index.config.name)
    .sort();
}

describe("autonomous action ledger schema", () => {
  it("declares action, idempotency, and effect uniqueness per company", () => {
    expect(uniqueIndexNames()).toEqual([
      "autonomous_action_ledger_company_action_id_uq",
      "autonomous_action_ledger_company_effect_key_uq",
      "autonomous_action_ledger_company_idempotency_key_uq",
    ]);
  });
});

describeEmbeddedPostgres("autonomous action ledger persistence", () => {
  it("deduplicates and consumes an action exactly once across retries", async () => {
    const embedded = await startEmbeddedPostgresTestDatabase("autonomous-action-ledger-");
    cleanups.push(embedded.cleanup);
    await applyPendingMigrations(embedded.connectionString);
    const db = createDb(embedded.connectionString);
    cleanups.push(async () => db.$client.end({ timeout: 1 }));
    const companyId = "00000000-0000-0000-0000-000000000017";
    await db.insert(companies).values({ id: companyId, name: "Autonomous ledger test" });

    const first = await registerAutonomousAction(db, companyId, request);
    expect(first).toMatchObject({ outcome: "ACCEPT", reasonCode: "new_effect" });

    const duplicate = await registerAutonomousAction(db, companyId, request);
    expect(duplicate).toMatchObject({
      outcome: "RETURN_EXISTING",
      reasonCode: "duplicate_effect",
      existingActionId: request.actionId,
    });

    const conflict = await registerAutonomousAction(db, companyId, {
      ...request,
      actionId: "autonomous-action/run-1/task-1/1/WAKEUP-conflict",
      effectPayload: { target: "different-task" },
    });
    expect(conflict).toMatchObject({ outcome: "REJECT", reasonCode: "idempotency_conflict" });

    const consumed = await consumeAutonomousActionOnce(db, companyId, request);
    expect(consumed).toMatchObject({ outcome: "CONSUMED", actionId: request.actionId });
    expect(await completeAutonomousAction(db, companyId, request.actionId)).toBe(true);

    const replay = await consumeAutonomousActionOnce(db, companyId, request);
    expect(replay).toMatchObject({ outcome: "ALREADY_CONSUMED", actionId: request.actionId });

    const concurrentRequest: AutonomousActionRequest = {
      ...request,
      actionId: "autonomous-action/run-2/task-1/1/WAKEUP",
      idempotencyKey: "autonomous-idempotency/run-2/task-1/1/WAKEUP",
      executionId: "run-2",
    };
    const concurrent = await Promise.all([
      consumeAutonomousActionOnce(db, companyId, concurrentRequest),
      consumeAutonomousActionOnce(db, companyId, concurrentRequest),
    ]);
    expect(concurrent.map((result) => result.outcome).sort()).toEqual([
      "ALREADY_CONSUMED",
      "CONSUMED",
    ]);

    const rows = await db
      .select({ status: autonomousActionLedger.status })
      .from(autonomousActionLedger)
      .orderBy(autonomousActionLedger.createdAt);
    expect(rows).toEqual([{ status: "consumed" }, { status: "claimed" }]);
  }, 240_000);

  it("retries stale pre-dispatch claims but does not replay a dispatched handoff", async () => {
    const embedded = await startEmbeddedPostgresTestDatabase("autonomous-action-recovery-");
    cleanups.push(embedded.cleanup);
    await applyPendingMigrations(embedded.connectionString);
    const db = createDb(embedded.connectionString);
    cleanups.push(async () => db.$client.end({ timeout: 1 }));
    const companyId = "00000000-0000-0000-0000-000000000018";
    await db.insert(companies).values({ id: companyId, name: "Autonomous recovery test" });

    const first = await consumeAutonomousActionOnce(db, companyId, { ...request, actionId: "recovery-pre", idempotencyKey: "recovery-pre-key" });
    expect(first.outcome).toBe("CONSUMED");
    await db.update(autonomousActionLedger).set({ updatedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(autonomousActionLedger.actionId, "recovery-pre"));
    const retried = await consumeAutonomousActionOnce(db, companyId, { ...request, actionId: "recovery-pre", idempotencyKey: "recovery-pre-key" });
    expect(retried.outcome).toBe("CONSUMED");

    const handoff = await consumeAutonomousActionOnce(db, companyId, { ...request, actionId: "recovery-handoff", idempotencyKey: "recovery-handoff-key" });
    expect(handoff.outcome).toBe("CONSUMED");
    expect(await markAutonomousActionDispatched(db, companyId, "recovery-handoff")).toBe(true);
    await db.update(autonomousActionLedger).set({ updatedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(autonomousActionLedger.actionId, "recovery-handoff"));
    const noReplay = await consumeAutonomousActionOnce(db, companyId, { ...request, actionId: "recovery-handoff", idempotencyKey: "recovery-handoff-key" });
    expect(noReplay.outcome).toBe("ALREADY_CONSUMED");
  }, 240_000);
});
