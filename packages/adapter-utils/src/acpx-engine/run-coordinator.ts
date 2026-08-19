// The run coordinator.
//
// One `run()` coordinator owns the attempt. It sequences four steps: startup,
// turn, settlement, and result reproduction. It holds the routing table as
// data:
//
//   * A build failure or a partial-bridge failure throws from startup. The
//     coordinator's one catch replays the `startup_rollback` entries through the
//     partial ledger, records the disposition report, and rethrows.
//   * A runtime-create, handshake, missing-handle, or configuration failure
//     produces a `settle` result. The coordinator settles the resources, then
//     reproduces the error result.
//   * Every other startup outcome produces a `ready` result. The coordinator
//     runs the turn, settles the resources, then reproduces the turn result.
//
// The coordinator has no catch around the turn: the turn never rejects and
// returns a typed `TurnCompletion` (Phase 21). The external result is reproduced
// AFTER settlement, so a caller never observes a result before the run releases
// its resources.

import type {
  AcquiredRunResources,
  ConsumedRunResources,
  PreTurnFailedCause,
  ResourceDisposition,
  ResourceId,
  StartupReady,
  StartupResult,
  TurnCompletion,
} from "./run-contracts.js";

/** One resource's final disposition, as the coordinator or settlement records it. */
export interface ResourceDispositionRecord {
  readonly id: ResourceId;
  readonly disposition: ResourceDisposition;
}

/** The per-resource disposition report the coordinator records at each end. */
export interface SettlementDispositionReport {
  readonly records: readonly ResourceDispositionRecord[];
}

/** The cause the coordinator hands to settlement. A clean turn carries no cause. */
export type SettlementReason =
  | { readonly kind: "pre_turn"; readonly cause: PreTurnFailedCause }
  | { readonly kind: "turn"; readonly completion: TurnCompletion };

/** The outcome the coordinator hands to result reproduction. */
export type ReproducibleOutcome = SettlementReason;

/**
 * The four steps the coordinator sequences, plus the run ledger. The engine
 * supplies each step; the coordinator owns only the order and the startup
 * rollback. This keeps the coordinator free of the engine's private run state.
 */
export interface RunPlan<TResult> {
  /** The one run ledger for the attempt. The coordinator creates it (see `runAttempt`). */
  readonly ledger: AcquiredRunResources;
  /**
   * Run the startup sequence. It returns a `ready` or a `settle` result, or it
   * throws on a build failure or a partial-bridge failure.
   */
  startup(): Promise<StartupResult>;
  /**
   * Replay the `startup_rollback` entries the partial ledger carries. The
   * coordinator calls it only on a startup throw, with the claimed entries.
   */
  rollbackStartup(consumed: ConsumedRunResources): Promise<void> | void;
  /** Record the per-resource disposition report at the end of the run. */
  recordDisposition(report: SettlementDispositionReport): void;
  /** Run the turn against the ready resources. It never rejects. */
  runTurn(ready: StartupReady): Promise<TurnCompletion>;
  /**
   * Settle the run's resources for the given reason. The one cleanup owner. A
   * synchronous return adds no awaited boundary, so a step that already settled
   * inline keeps the caller's timing unchanged.
   */
  settle(reason: SettlementReason): void | Promise<void>;
  /** Reproduce the external result after settlement. */
  reproduceResult(outcome: ReproducibleOutcome): TResult | Promise<TResult>;
}

/**
 * Run the attempt through the routing table. The coordinator is the one owner of
 * the startup-to-settlement order.
 */
export async function runAttempt<TResult>(plan: RunPlan<TResult>): Promise<TResult> {
  let startupResult: StartupResult;
  try {
    startupResult = await plan.startup();
  } catch (startupError) {
    // The coordinator's only catch wraps startup. A build failure and a
    // partial-bridge failure reach here. Claim the partial ledger, replay its
    // `startup_rollback` entries, record the disposition report (each entry the
    // rollback released is `finalized`), and rethrow the original error.
    const consumed = plan.ledger.takeForSettlement();
    await plan.rollbackStartup(consumed);
    plan.recordDisposition(finalizedReport(consumed));
    throw startupError;
  }

  if (startupResult.kind === "settle") {
    // A pre-turn failure after the ledger acquired resources. Settle the
    // resources, then reproduce the error result AFTER settlement.
    const reason: SettlementReason = { kind: "pre_turn", cause: startupResult.cause };
    const settled = plan.settle(reason);
    if (settled) await settled;
    return plan.reproduceResult(reason);
  }

  // The ready path: run the turn, settle, then reproduce the result. There is no
  // catch around the turn — `runTurn` never rejects.
  const completion = await plan.runTurn(startupResult);
  const reason: SettlementReason = { kind: "turn", completion };
  const settled = plan.settle(reason);
  if (settled) await settled;
  return plan.reproduceResult(reason);
}

/** Build a disposition report that marks every claimed entry `finalized`. */
function finalizedReport(consumed: ConsumedRunResources): SettlementDispositionReport {
  return {
    records: consumed.entries().map((entry) => ({ id: entry.id, disposition: "finalized" as const })),
  };
}
