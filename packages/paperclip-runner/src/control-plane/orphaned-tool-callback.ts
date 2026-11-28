/**
 * Host-tool callbacks orphaned by a server restart.
 *
 * A provider tool call reaches Paperclip as a durable semantic input. The
 * server process that hosts the run's controller executes it and journals the
 * result. When that server restarts mid-call, the replacement controller
 * restores the journal: the input is there, its result is not, and the old
 * process can never record one (its journal writer is retired and its
 * checkpoint fence is superseded). Without a decision the input stays pending
 * forever, so close cannot prove the provider drained and the session
 * quarantines.
 *
 * Recovery first asks the tool authority for a durable receipt and replays
 * only that. When none exists and this callback's owner is provably gone, the
 * callback settles as interrupted with an unknown outcome. It is never
 * executed again. A callback that this process is still running, or that this
 * process dispatched and saw fail, stays pending.
 *
 * Exception: an authority may settle a transactional write itself, for any
 * admission, when its effect and receipt commit in one locked transaction
 * (server `TRANSACTIONAL_RECEIPT_OPERATIONS`, today only `write_document`).
 * Its `recover` then runs the receipt-guarded write, which replays the saved
 * result or applies it once; the owner-gone guard here is not what makes that
 * safe.
 */

import type { SemanticInputAdmission } from "./durable-prp-control-plane.js";

export const TOOL_CALLBACK_INTERRUPTED_CODE = "tool_call_interrupted_by_restart";

type CallbackOutcome = { readonly result: unknown; readonly isError?: boolean };
type ToolCallbackCall = { tool: string; callId: string; arguments: unknown };

const FAILED_DISPATCH_MEMORY = 4_096;
const runningDispatches = new Map<string, number>();
const failedDispatches = new Set<string>();

function callbackKey(runId: string, callId: string): string {
  return `${runId}\0${callId}`;
}

/** Run one host-tool callback and record that this process owns it while it
 * runs. A rejected dispatch does not prove that its effect rolled back, so
 * this process remembers it and never settles it as abandoned. */
export async function dispatchToolCallback<T>(runId: string, callId: string, execute: () => Promise<T>): Promise<T> {
  const key = callbackKey(runId, callId);
  runningDispatches.set(key, (runningDispatches.get(key) ?? 0) + 1);
  let completed = false;
  try {
    const value = await execute();
    completed = true;
    return value;
  } finally {
    const remaining = (runningDispatches.get(key) ?? 1) - 1;
    if (remaining > 0) runningDispatches.set(key, remaining);
    else runningDispatches.delete(key);
    if (!completed) {
      failedDispatches.delete(key);
      failedDispatches.add(key);
      // Bound process memory. Evicting the oldest failure only lets a much
      // older callback settle as interrupted later; it never replays it.
      if (failedDispatches.size > FAILED_DISPATCH_MEMORY) {
        failedDispatches.delete(failedDispatches.values().next().value!);
      }
    }
  }
}

/** True while this process runs the callback, or after it saw it fail. */
export function toolCallbackOwnedByThisProcess(runId: string, callId: string): boolean {
  const key = callbackKey(runId, callId);
  return runningDispatches.has(key) || failedDispatches.has(key);
}

/** The result the provider receives for a callback that a restart cut off. */
export function interruptedToolCallbackOutcome(): CallbackOutcome {
  return {
    isError: true,
    result: {
      error: {
        code: TOOL_CALLBACK_INTERRUPTED_CODE,
        outcome: "unknown",
        retryable: false,
        message: "Paperclip restarted while this tool call was running, so its result was lost. "
          + "It may or may not have taken effect. Check the current state before you repeat it.",
      },
    },
  };
}

/**
 * Resolve a saved callback that has no journaled result.
 *
 * The owner is gone when an earlier controller dispatched the callback (this
 * controller restored it from that controller's journal) and this process is
 * not running it. A callback this controller dispatched keeps the earlier
 * rule: without a durable receipt it stays pending.
 */
export async function recoverToolCallback(input: {
  runId: string;
  call: ToolCallbackCall;
  admission: SemanticInputAdmission | undefined;
  recover: () => Promise<CallbackOutcome | null>;
}): Promise<CallbackOutcome | null> {
  const ownerGone = () => input.admission === "earlier_controller"
    && !toolCallbackOwnedByThisProcess(input.runId, input.call.callId);
  let outcome: CallbackOutcome | null;
  try {
    outcome = await input.recover();
  } catch (error) {
    // A receipt that proves an unknown outcome settles the same way once its
    // owner is gone. Otherwise keep the earlier, fail-closed rejection.
    if (!isSemanticToolOutcomeUnknown(error) || !ownerGone()) throw error;
    return interruptedToolCallbackOutcome();
  }
  if (outcome) return outcome;
  return ownerGone() ? interruptedToolCallbackOutcome() : null;
}

function isSemanticToolOutcomeUnknown(error: unknown): boolean {
  // Match across the server's vendored and source-mode runtime boundaries.
  return error instanceof Error && "code" in error && error.code === "semantic_tool_outcome_unknown";
}
