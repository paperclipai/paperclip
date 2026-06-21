import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RecoveryWorkflowParams } from "./types";
import { makeInternalClient } from "./internal-client";
import { runRecoveryLoop } from "./loop";

// Re-export for testability
export { runRecoveryLoop } from "./loop";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, RecoveryWorkflowParams> {
  async run(event: WorkflowEvent<RecoveryWorkflowParams>, step: WorkflowStep): Promise<void> {
    const client = makeInternalClient(this.env);
    // step.do callback receives (ctx: WorkflowStepContext) — we pass step directly.
    // LoopStep interface uses a compatible structural subtype.
    await runRecoveryLoop({ payload: event.payload, step: step as never, client });
  }
}

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
