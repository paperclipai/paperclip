// The turn sequence.
//
// `runTurn(steps)` is a plain sequence. It runs five steps in a fixed order:
// promptBuild, preTurnUsage, turnStart, eventRelay, turnFinalize. It never
// rejects: every step error becomes a typed `TurnCompletion` through the
// `turnFinalize` step. The sequence owns the wall-clock timer and the abort
// controller. It borrows the run resources; it finalizes no resource. The
// coordinator (Phase 20) settles the resources after the turn.
//
// The sequence is data, not a graph and not a state machine. The engine supplies
// each step; the sequence owns only the order, the timer, and the abort signal.
// This keeps the sequence free of the engine's private run state.

import type { TurnCompletion } from "./run-contracts.js";

/**
 * A turn the site started. The sequence borrows it to cancel it on a timeout; it
 * releases nothing. The engine's `eventRelay` step reads the events and the
 * terminal result.
 */
export interface StartedTurn {
  cancel(reason: string): Promise<void>;
}

/**
 * The input the sequence hands to the one `turnFinalize` step. A `terminal`
 * input carries the turn's terminal result; an `error` input carries the step
 * error and the phase it failed in. Both carry the wall-clock timeout flag.
 */
export type TurnFinalizeInput<TTerminal> =
  | { readonly kind: "terminal"; readonly terminal: TTerminal; readonly timedOut: boolean }
  | {
      readonly kind: "error";
      readonly error: unknown;
      readonly phase: "prepare_turn" | "turn";
      readonly timedOut: boolean;
    };

/**
 * The five steps the sequence runs, plus the timer inputs. The engine implements
 * each step over its own run state. `turnFinalize` maps a terminal result or a
 * step error to a `TurnCompletion`; it must not reject, so the sequence never
 * rejects.
 */
export interface TurnSteps<TTerminal> {
  /** The wall-clock timeout, in milliseconds, or undefined for no timeout. */
  readonly timeoutMs: number | undefined;
  /** The message the timeout cancel carries. */
  readonly timeoutMessage: string;
  /** Build the prompt and emit the run metadata. A failure here is `prepare_turn`. */
  promptBuild(signal: AbortSignal): Promise<void>;
  /** Snapshot the pre-turn usage, so this run's cost excludes earlier runs. */
  preTurnUsage(): Promise<void>;
  /** Start the turn with the run's six inputs. The sequence adds the signal and the timeout. */
  turnStart(signal: AbortSignal, timeoutMs: number | undefined): StartedTurn;
  /** Relay the turn events and return the terminal result. */
  eventRelay(turn: StartedTurn): Promise<TTerminal>;
  /** Map a terminal result or a step error to a `TurnCompletion`. Must not reject. */
  turnFinalize(input: TurnFinalizeInput<TTerminal>): Promise<TurnCompletion>;
}

/**
 * Run the turn sequence. It returns a `TurnCompletion` on every path and never
 * rejects. A failure before `turnStart` returns is a `prepare_turn` failure; a
 * failure after it is a `turn` failure. Only the reported phase differs.
 */
export async function runTurn<TTerminal>(steps: TurnSteps<TTerminal>): Promise<TurnCompletion> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let started: StartedTurn | null = null;
  // `turnStarted` separates a pre-turn preparation failure from a running-turn
  // failure, so `turnFinalize` reports the right phase.
  let turnStarted = false;
  try {
    // Build the prompt and snapshot the pre-turn usage inside the failure
    // boundary. A failure here is a `prepare_turn` failure.
    await steps.promptBuild(controller.signal);
    await steps.preTurnUsage();
    // The sequence owns the wall-clock timer. On a timeout it marks the run timed
    // out, aborts the shared signal, and cancels the started turn. The cancel
    // no-ops before `turnStart` returns, because `started` is still null.
    if (steps.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void started?.cancel(steps.timeoutMessage).catch(() => {});
      }, steps.timeoutMs);
    }
    started = steps.turnStart(controller.signal, steps.timeoutMs);
    turnStarted = true;
    const terminal = await steps.eventRelay(started);
    if (timeout) clearTimeout(timeout);
    return await steps.turnFinalize({ kind: "terminal", terminal, timedOut });
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    const phase: "prepare_turn" | "turn" = turnStarted ? "turn" : "prepare_turn";
    return await steps.turnFinalize({ kind: "error", error, phase, timedOut });
  }
}
