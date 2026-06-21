/**
 * runRecoveryLoop — the durable attempt/sleep loop for RecoveryWorkflow.
 *
 * Extracted into its own module (no cloudflare:workers imports) so it can be
 * unit-tested with plain vitest/node using a hand-mocked step object.
 *
 * Design decision — simple sleep loop (no Promise.race):
 * Cloudflare Workflows replays every step from the beginning on resumption.
 * Racing step.sleep against step.waitForEvent is unreliable during replay
 * because the execution order of concurrent step continuations is not
 * guaranteed to be stable. step.waitForEvent does exist in the Cloudflare
 * Workflows API, but Promise.race with durable steps is unreliable during
 * replay; using simple sleep loop instead.
 *
 * The loop self-exits when active:false is returned by the attempt endpoint,
 * which is how server-side cancellation/resolution is signalled.
 */

import type { InternalClient } from "./internal-client";
import type { RecoveryWorkflowParams } from "./types";

/**
 * Minimal structural interface for the step object used by the loop.
 * Avoids importing cloudflare:workers so this module stays node-testable.
 * The callback receives an optional context arg — we use `_ctx` and ignore it.
 */
interface LoopStep {
  do<T>(
    name: string,
    config: {
      retries: {
        limit: number;
        delay: string | number;
        backoff?: string;
      };
      timeout?: string | number;
    },
    callback: (ctx?: unknown) => Promise<T>
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

interface RunRecoveryLoopOptions {
  payload: RecoveryWorkflowParams;
  step: LoopStep;
  client: InternalClient;
}

/**
 * Floor for the inter-attempt sleep. Guards against a tight-spin if the server
 * ever returns `{ active: true, nextIntervalMs: 0 }` (bug/malformed response):
 * step.sleep(0) resolves ~immediately and would burn step history + API quota.
 */
export const MIN_SLEEP_MS = 1000;

export async function runRecoveryLoop({
  payload,
  step,
  client,
}: RunRecoveryLoopOptions): Promise<void> {
  const { companyId, actionId, sourceIssueId, mode } = payload;
  // Translate the workflow's authority mode to the server attempt endpoint's
  // WIRE mode: shadow authority => "dry" (observe, no writes); active => "active".
  // The server validates mode against z.enum(["dry","active"]) and would 400 on
  // a raw "shadow", so this translation is required for shadow runs to function.
  const attemptMode: "dry" | "active" = mode === "active" ? "active" : "dry";
  let n = 0;

  while (true) {
    n += 1;

    const res = await step.do(
      `attempt-${n}`,
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } },
      () => client.attempt({ companyId, actionId, sourceIssueId, attemptNumber: n, mode: attemptMode })
    );

    if (!res.active) {
      return;
    }

    await step.sleep(`wait-${n}`, Math.max(res.nextIntervalMs ?? 0, MIN_SLEEP_MS));
  }
}
