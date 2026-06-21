import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RecoveryWorkflowParams } from "./types.ts";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, RecoveryWorkflowParams> {
  async run(event: WorkflowEvent<RecoveryWorkflowParams>, step: WorkflowStep): Promise<void> {
    // loop logic added in Task 6
    await step.do("noop", async () => {});
  }
}

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
