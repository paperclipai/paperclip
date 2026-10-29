import { describe, expect, it } from "vitest";
import { runAttempt, type RunPlan, type SettlementReason } from "./run-coordinator.js";
import { createRunResourceLedger } from "./run-resource-ledger.js";
import type {
  AcquiredRunResources,
  PreTurnFailedCause,
  ReadyRunResources,
  StartupReady,
  StartupResult,
  TurnCompletion,
} from "./run-contracts.js";

// The coordinator owns the run routing table. These tests drive it with fakes
// for the four steps (startup, turn, settle, reproduce) and assert the order and
// the routing, never the engine's real run state.

const readyResources = {} as ReadyRunResources;

function readyStartup(): StartupReady {
  return { kind: "ready", resources: readyResources, context: {} as StartupReady["context"] };
}

function preTurnCause(): PreTurnFailedCause {
  return { kind: "pre_turn_failed", phase: "handshake", error: new Error("handshake boom") };
}

function finalizedTurn(): TurnCompletion {
  return { kind: "finalized" };
}

// A minimal plan whose steps push their names into `order`, so a test reads the
// exact sequence the coordinator ran.
function makePlan(
  order: string[],
  overrides: Partial<RunPlan<string>> & { ledger?: AcquiredRunResources } = {},
): RunPlan<string> {
  const ledger = overrides.ledger ?? createRunResourceLedger();
  return {
    ledger,
    startup: overrides.startup ?? (async (): Promise<StartupResult> => {
      order.push("startup");
      return readyStartup();
    }),
    rollbackStartup: overrides.rollbackStartup ?? ((consumed) => {
      order.push(`rollback:${consumed.entries().length}`);
    }),
    recordDisposition: overrides.recordDisposition ?? ((report) => {
      order.push(`disposition:${report.records.map((r) => `${r.id}=${r.disposition}`).join(",")}`);
    }),
    runTurn: overrides.runTurn ?? (async (): Promise<TurnCompletion> => {
      order.push("turn");
      return finalizedTurn();
    }),
    settle: overrides.settle ?? (async (reason: SettlementReason) => {
      order.push(`settle:${reason.kind}`);
    }),
    reproduceResult: overrides.reproduceResult ?? (async (outcome) => {
      order.push(`reproduce:${outcome.kind}`);
      return "result";
    }),
  };
}

describe("ACPX run coordinator", () => {
  it("test_startup_throw_replays_startup_rollback_entries_and_rethrows", async () => {
    const order: string[] = [];
    // Fill a partial ledger with two startup_rollback entries that record their
    // release order when the rollback replays them.
    const ledger = createRunResourceLedger();
    const released: string[] = [];
    ledger.register({
      id: "staged_runtime",
      payload: {
        stagedRuntime: {} as never,
        disposeStaged: async () => {
          released.push("staged_runtime");
        },
      },
      scope: "startup_rollback",
    });
    ledger.register({
      id: "control_bridge",
      payload: { stop: async () => { released.push("control_bridge"); } } as never,
      scope: "startup_rollback",
    });

    const boom = new Error("build boom");
    const plan = makePlan(order, {
      ledger,
      startup: async (): Promise<StartupResult> => {
        order.push("startup");
        throw boom;
      },
      // Replay every claimed entry through its own release, newest first.
      rollbackStartup: async (consumed) => {
        for (const entry of [...consumed.entries()].reverse()) {
          if (entry.id === "staged_runtime") {
            await (entry.payload as { disposeStaged: () => Promise<void> }).disposeStaged();
          } else if (entry.id === "control_bridge") {
            await (entry.payload as { stop: () => Promise<void> }).stop();
          }
        }
        order.push("rollback");
      },
    });

    // The coordinator rethrows the original startup error.
    await expect(runAttempt(plan)).rejects.toBe(boom);
    // It replayed the startup_rollback entries through the partial ledger...
    expect(released).toEqual(["control_bridge", "staged_runtime"]);
    // ...recorded a disposition report that marks each claimed entry finalized...
    expect(order).toEqual([
      "startup",
      "rollback",
      "disposition:staged_runtime=finalized,control_bridge=finalized",
    ]);
    // ...and never ran the turn or the settlement.
    expect(order).not.toContain("turn");
    expect(order.some((step) => step.startsWith("settle"))).toBe(false);
  });

  it("test_settle_path_returns_error_result_after_settlement", async () => {
    const order: string[] = [];
    const cause = preTurnCause();
    const plan = makePlan(order, {
      startup: async (): Promise<StartupResult> => {
        order.push("startup");
        return { kind: "settle", cause, resources: createRunResourceLedger().takeForSettlement() };
      },
      settle: async (reason) => {
        expect(reason.kind).toBe("pre_turn");
        order.push("settle");
      },
      reproduceResult: async (outcome) => {
        expect(outcome.kind).toBe("pre_turn");
        order.push("reproduce");
        return "error-result";
      },
    });

    const result = await runAttempt(plan);
    expect(result).toBe("error-result");
    // The settle path never runs the turn; it settles first, then reproduces.
    expect(order).toEqual(["startup", "settle", "reproduce"]);
  });

  it("test_ready_path_runs_turn_then_settles_then_reproduces_result", async () => {
    const order: string[] = [];
    const plan = makePlan(order);

    const result = await runAttempt(plan);
    expect(result).toBe("result");
    // The ready path runs the turn, settles, then reproduces — in that order.
    expect(order).toEqual(["startup", "turn", "settle:turn", "reproduce:turn"]);
  });

  it("test_coordinator_has_no_catch_around_the_turn", async () => {
    // `runTurn` is contracted never to reject. This test proves the coordinator
    // holds no catch around the turn: an (illegal) turn rejection propagates out
    // of `runAttempt` unchanged, and neither settlement nor result reproduction
    // runs. A catch around the turn would swallow the rejection and route it into
    // settlement, so this rejection-propagation is the structural proof.
    const order: string[] = [];
    const boom = new Error("turn must never reject");
    const settleCalls: number[] = [];
    const reproduceCalls: number[] = [];
    const plan = makePlan(order, {
      runTurn: async (): Promise<TurnCompletion> => {
        throw boom;
      },
      settle: async () => {
        settleCalls.push(1);
      },
      reproduceResult: async () => {
        reproduceCalls.push(1);
        return "unreachable";
      },
    });

    await expect(runAttempt(plan)).rejects.toBe(boom);
    expect(settleCalls).toHaveLength(0);
    expect(reproduceCalls).toHaveLength(0);
  });
});
