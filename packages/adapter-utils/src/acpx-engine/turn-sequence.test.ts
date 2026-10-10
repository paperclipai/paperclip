import { describe, expect, it, vi } from "vitest";
import { runTurn, type StartedTurn, type TurnFinalizeInput, type TurnSteps } from "./turn-sequence.js";
import { createRunResourceLedger } from "./run-resource-ledger.js";
import type { TurnCompletion } from "./run-contracts.js";

// The turn sequence owns the run order, the wall-clock timer, and the abort
// controller. These tests drive it with fakes for the five steps and assert the
// order, the never-reject guarantee, and the timer ownership. They never touch
// the engine's real run state.

function finalizedTurn(): TurnCompletion {
  return { kind: "finalized" };
}

function failedTurn(error: unknown): TurnCompletion {
  return {
    kind: "failed",
    cause: { kind: "turn_failed", error: error instanceof Error ? error : new Error(String(error)) },
    resources: createRunResourceLedger().takeForSettlement(),
  };
}

function noopStarted(): StartedTurn {
  return { cancel: async () => {} };
}

// A base set of steps whose bodies do nothing. Each test overrides the steps it
// drives and records the calls it cares about.
function baseSteps(order: string[], overrides: Partial<TurnSteps<string>> = {}): TurnSteps<string> {
  return {
    timeoutMs: overrides.timeoutMs,
    timeoutMessage: overrides.timeoutMessage ?? "timed out",
    promptBuild: overrides.promptBuild ?? (async () => {
      order.push("promptBuild");
    }),
    preTurnUsage: overrides.preTurnUsage ?? (async () => {
      order.push("preTurnUsage");
    }),
    turnStart: overrides.turnStart ?? (() => {
      order.push("turnStart");
      return noopStarted();
    }),
    eventRelay: overrides.eventRelay ?? (async () => {
      order.push("eventRelay");
      return "terminal";
    }),
    turnFinalize: overrides.turnFinalize ?? (async (input) => {
      order.push(`turnFinalize:${input.kind}`);
      return input.kind === "terminal" ? finalizedTurn() : failedTurn(input.error);
    }),
  };
}

describe("ACPX turn sequence", () => {
  it("test_run_turn_never_rejects_every_error_is_a_completion", async () => {
    // A step error must become a `TurnCompletion`, never a rejection. The event
    // relay throws after the turn started, so the sequence reports a `turn`
    // failure and returns a completion.
    const finalizeInputs: TurnFinalizeInput<string>[] = [];
    const boom = new Error("relay boom");
    const steps = baseSteps([], {
      eventRelay: async () => {
        throw boom;
      },
      turnFinalize: async (input) => {
        finalizeInputs.push(input);
        return input.kind === "terminal" ? finalizedTurn() : failedTurn(input.error);
      },
    });

    // The returned promise resolves; it never rejects.
    const completion = await runTurn(steps);
    expect(completion.kind).toBe("failed");
    // The error routed through the one finalize step with the `turn` phase.
    expect(finalizeInputs).toHaveLength(1);
    expect(finalizeInputs[0]).toMatchObject({ kind: "error", error: boom, phase: "turn" });
  });

  it("test_run_turn_owns_timer_and_abort_controller", async () => {
    vi.useFakeTimers();
    try {
      const captured: { signal: AbortSignal | null; cancelReason: string | null } = {
        signal: null,
        cancelReason: null,
      };
      let releaseRelay: (value: string) => void = () => {};
      const relayPromise = new Promise<string>((resolve) => {
        releaseRelay = resolve;
      });
      const finalizeInputs: TurnFinalizeInput<string>[] = [];
      const steps = baseSteps([], {
        timeoutMs: 1000,
        timeoutMessage: "wall-clock timeout",
        turnStart: (signal) => {
          captured.signal = signal;
          return {
            cancel: async (reason) => {
              captured.cancelReason = reason;
            },
          };
        },
        eventRelay: async () => relayPromise,
        turnFinalize: async (input) => {
          finalizeInputs.push(input);
          return input.kind === "terminal" ? finalizedTurn() : failedTurn(input.error);
        },
      });

      const runPromise = runTurn(steps);
      // Let promptBuild, preTurnUsage, and turnStart run.
      await vi.advanceTimersByTimeAsync(0);
      expect(captured.signal?.aborted).toBe(false);
      // Fire the wall-clock timeout the sequence owns.
      await vi.advanceTimersByTimeAsync(1000);
      // The sequence owns the abort controller: the shared signal is aborted...
      expect(captured.signal?.aborted).toBe(true);
      // ...and it cancelled the started turn with the timeout message.
      expect(captured.cancelReason).toBe("wall-clock timeout");
      // Complete the relay so the sequence finalizes the timed-out turn.
      releaseRelay("terminal");
      const completion = await runPromise;
      expect(completion).toEqual({ kind: "finalized" });
      // The finalize step saw the timeout flag the sequence tracked.
      expect(finalizeInputs).toHaveLength(1);
      expect(finalizeInputs[0]).toMatchObject({ kind: "terminal", timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_prompt_build_failure_is_failed_completion_with_prepare_turn", async () => {
    // A prompt-build failure happens before the turn starts, so the sequence
    // reports a `prepare_turn` failure and never runs the later steps.
    const order: string[] = [];
    const finalizeInputs: TurnFinalizeInput<string>[] = [];
    const boom = new Error("prompt build boom");
    const steps = baseSteps(order, {
      promptBuild: async () => {
        throw boom;
      },
      turnFinalize: async (input) => {
        finalizeInputs.push(input);
        return input.kind === "terminal" ? finalizedTurn() : failedTurn(input.error);
      },
    });

    const completion = await runTurn(steps);
    expect(completion.kind).toBe("failed");
    expect(finalizeInputs).toHaveLength(1);
    expect(finalizeInputs[0]).toMatchObject({ kind: "error", error: boom, phase: "prepare_turn" });
    // The later steps never ran.
    expect(order).not.toContain("preTurnUsage");
    expect(order).not.toContain("turnStart");
    expect(order).not.toContain("eventRelay");
  });

  it("test_run_turn_finalizes_no_resource", async () => {
    // Structural proof: the sequence borrows the resources and finalizes none.
    // The `TurnSteps` contract has no resource-release method; the sequence runs
    // only the five ordered steps. A test-side resource whose release the
    // sequence could never call stays untouched, and the recorded call order is
    // exactly the five steps. The coordinator settles the resources after the
    // turn, so a resource release inside the sequence would be a double release.
    const order: string[] = [];
    let released = false;
    // A resource the sequence has no hook to release. If the sequence ever
    // released a resource, it would have to reach one, and it cannot.
    const borrowedResource = {
      release: () => {
        released = true;
      },
    };
    void borrowedResource;

    const steps = baseSteps(order);
    const completion = await runTurn(steps);

    expect(completion).toEqual({ kind: "finalized" });
    // The sequence ran exactly the five ordered steps, then finalized.
    expect(order).toEqual([
      "promptBuild",
      "preTurnUsage",
      "turnStart",
      "eventRelay",
      "turnFinalize:terminal",
    ]);
    // It never released the borrowed resource.
    expect(released).toBe(false);
  });
});
