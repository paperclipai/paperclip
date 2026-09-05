// The turn sequence.
//
// `runTurn(steps)` is a plain sequence. It runs five steps in a fixed order:
// promptBuild, preTurnUsage, turnStart, eventRelay, turnFinalize. It never
// rejects: every step error becomes a typed `TurnCompletion` through the
// `turnFinalize` step. The sequence owns the wall-clock timer, the stale-turn
// watchdog, and the abort controller. It borrows the run resources; it
// finalizes no resource. The coordinator (Phase 20) settles the resources
// after the turn.
//
// The sequence is data, not a graph and not a state machine. The engine supplies
// each step and reports real progress through `markProgress`; the sequence owns
// only the order, the timers, and the abort signal. This keeps the sequence free
// of the engine's private run state.

import type { TurnCompletion } from "./run-contracts.js";

/**
 * A turn the site started. The sequence borrows it to cancel it on a timeout or
 * a stale abort; it releases nothing. The engine's `eventRelay` step reads the
 * events and the terminal result.
 */
export interface StartedTurn {
  cancel(reason: string): Promise<void>;
}

/**
 * The input the sequence hands to the one `turnFinalize` step. A `terminal`
 * input carries the turn's terminal result; an `error` input carries the step
 * error and the phase it failed in. `timedOut` is the wall-clock flag;
 * `staleTimedOut` is the stale-turn watchdog flag. They are independent: the
 * sequence sets at most one.
 */
export type TurnFinalizeInput<TTerminal> =
  | {
      readonly kind: "terminal";
      readonly terminal: TTerminal;
      readonly timedOut: boolean;
      readonly staleTimedOut: boolean;
    }
  | {
      readonly kind: "error";
      readonly error: unknown;
      readonly phase: "prepare_turn" | "turn";
      readonly timedOut: boolean;
      readonly staleTimedOut: boolean;
    };

/**
 * The watch the sequence hands the `eventRelay` step. `markProgress` refreshes
 * the stale-turn watchdog; `signal` is the same abort the sequence passes to
 * `turnStart`.
 */
export interface TurnRelayWatch {
  markProgress(): void;
  readonly signal: AbortSignal;
}

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
  /**
   * The stale-turn inactivity timeout, in milliseconds. 0 or undefined
   * disables the watchdog (wall-clock timeout only).
   */
  readonly staleTimeoutMs?: number;
  /** The message the stale-turn cancel carries. Ignored when the watchdog is off. */
  readonly staleTimeoutMessage?: string;
  /** Build the prompt and emit the run metadata. A failure here is `prepare_turn`. */
  promptBuild(signal: AbortSignal): Promise<void>;
  /** Snapshot the pre-turn usage, so this run's cost excludes earlier runs. */
  preTurnUsage(): Promise<void>;
  /** Start the turn with the run's six inputs. The sequence adds the signal and the timeout. */
  turnStart(signal: AbortSignal, timeoutMs: number | undefined): StartedTurn;
  /** Relay the turn events and return the terminal result. */
  eventRelay(turn: StartedTurn, watch: TurnRelayWatch): Promise<TTerminal>;
  /** Map a terminal result or a step error to a `TurnCompletion`. Must not reject. */
  turnFinalize(input: TurnFinalizeInput<TTerminal>): Promise<TurnCompletion>;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Run the turn sequence. It returns a `TurnCompletion` on every path and never
 * rejects. A failure before `turnStart` returns is a `prepare_turn` failure; a
 * failure after it is a `turn` failure. Only the reported phase differs.
 */
export async function runTurn<TTerminal>(steps: TurnSteps<TTerminal>): Promise<TurnCompletion> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setInterval> | null = null;
  let timedOut = false;
  let staleTimedOut = false;
  let started: StartedTurn | null = null;
  // `turnStarted` separates a pre-turn preparation failure from a running-turn
  // failure, so `turnFinalize` reports the right phase.
  let turnStarted = false;
  let lastProgressAt = 0;
  const now = () => Date.now();
  const abortTurn = (kind: "wall_clock" | "stale", message: string) => {
    if (timedOut || staleTimedOut) return;
    if (kind === "stale") staleTimedOut = true;
    else timedOut = true;
    controller.abort();
    void started?.cancel(message).catch(() => {});
  };
  const clearTimers = () => {
    if (timeout) clearTimeout(timeout);
    if (staleTimer) clearInterval(staleTimer);
    timeout = null;
    staleTimer = null;
  };
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
        abortTurn("wall_clock", steps.timeoutMessage);
      }, steps.timeoutMs);
    }
    started = steps.turnStart(controller.signal, steps.timeoutMs);
    turnStarted = true;
    lastProgressAt = now();
    // Independent stale-turn watchdog: polls lastProgressAt so it still fires
    // when the event stream goes fully silent, not just when non-progress
    // heartbeats keep arriving. The engine refreshes lastProgressAt through
    // `markProgress`. Abort uses the same controller as the wall-clock timer.
    const staleTimeoutMs = steps.staleTimeoutMs ?? 0;
    if (staleTimeoutMs > 0) {
      staleTimer = setInterval(() => {
        if (now() - lastProgressAt < staleTimeoutMs) return;
        abortTurn("stale", steps.staleTimeoutMessage ?? "stale turn");
      }, Math.min(1_000, staleTimeoutMs));
      unrefTimer(staleTimer);
    }
    const terminal = await steps.eventRelay(started, {
      markProgress: () => {
        lastProgressAt = now();
      },
      signal: controller.signal,
    });
    clearTimers();
    return await steps.turnFinalize({ kind: "terminal", terminal, timedOut, staleTimedOut });
  } catch (error) {
    clearTimers();
    const phase: "prepare_turn" | "turn" = turnStarted ? "turn" : "prepare_turn";
    return await steps.turnFinalize({ kind: "error", error, phase, timedOut, staleTimedOut });
  }
}
