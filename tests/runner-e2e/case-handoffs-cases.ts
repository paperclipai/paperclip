import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const CASE_HANDOFF_MAX_TURNS = 6;
export const caseHandoffTask: RunnerTaskFixture = {
  id: "same-task-roundtrip", label: "One case/task across three agents and a review return", groups: [],
  flow: "case_handoff", workMode: "standard", expectedRunCount: CASE_HANDOFF_MAX_TURNS, minimumExpectedRunCount: 4,
  automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 12 * 60_000, daytona: 12 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Persistent case arithmetic ${nonce}`,
  buildPrompt: () => "Compute the supplied arithmetic result through the configured triage, implementation, verification and revision phases on one task.",
  buildVisibleMarker: nonce => `CASE-HANDOFF-DONE-${nonce}`,
  buildMatchers: () => [],
};
export function caseHandoffDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["case-handoffs-cases.ts", "case-handoffs-flow.ts", "case-handoffs-scoring.ts", "codex-subscription-fixture.ts", "live-fixtures.ts", "runner.spec.ts"]) {
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex");
}

export function caseHandoffInstructions(input: { nonce: string; triageId: string; implementationId: string; verificationId: string; workflowAId: string; workflowBId: string }) {
  return [
    `Workflow fixture nonce: ${input.nonce}. The inputs are a=2 and b=3. Your objective is a persisted, independently verified answer document with result 5.`,
    `This one task moves among triage=${input.triageId}, implementation=${input.implementationId}, verification=${input.verificationId}. Reuse this exact task; create no other tasks or agents.`,
    "Read the current incoming Workflow case context. Its phase and handoffVersion determine your step. If needed, use the public case/task read APIs through call_api to get case id, task id, current handoffVersion and issue statusVersion.",
    'On every phase read the current task workflow document with read_document. Before handing off or completing, save a task document with key phase-<phase>, title Phase <phase>, and JSON body {nonce,phase,caseId,taskId,handoffVersion,result,workflowMarker}. Copy workflowMarker exactly from the current workflow document. Use the observed current phase/version and computed result; do not guess future versions. Use write_document. These are durable observations for the next agent.',
    `The triage handoff must adopt workflowId=${input.workflowBId}. The implementation handoff must adopt workflowId=${input.workflowAId}. The verification handoff omits workflowId and preserves the current workflow. These changes keep this exact case and task.`,
    `Phase triage: inspect inputs and save phase-triage. Then call the actual handoff_case tool to ${input.implementationId}, phase implementation, instructions "${input.nonce}: Compute a+b from the case fields, save answer as JSON, and hand this task to verification. Follow the task workflow.".`,
    `Phase implementation: independently calculate 2+3 and write task document answer with JSON {"nonce":"${input.nonce}","a":2,"b":3,"result":5,"verified":false}. Save phase-implementation, then call handoff_case to ${input.verificationId}, phase verification, instructions "${input.nonce}: Read the persisted answer and verify 2+3 independently. Save phase-verification with result 5 and return to revision on the same task. Follow the task workflow.".`,
    `Phase verification: read the saved answer document through read_document; independently verify a+b equals the persisted result. Fail visibly if it differs. Save phase-verification with result 5. Then call handoff_case to ${input.implementationId}, phase revision, instructions "${input.nonce}: Verification passed for saved result 5. Read phase-verification, finalize answer with verified=true, and complete this same task normally. Follow the task workflow.".`,
    `Phase revision: read phase-verification and answer. Require the verified persisted result 5; do not recreate missing evidence. Save phase-revision. Update answer to JSON {"nonce":"${input.nonce}","a":2,"b":3,"result":5,"verified":true}, using its latest baseRevisionId. Then call handoff_case with to:"done", the observed case/task versions, and completion evidence plus CASE-HANDOFF-DONE-${input.nonce} in instructions. This terminal comment is the visible completion message. This terminal intent does not yield. Finish the full task normally with real document evidence and final response CASE-HANDOFF-DONE-${input.nonce}.`,
    "Every handoff needs case:{id:<current case id>}, instructions, a stable unique idempotencyKey, expectedHandoffVersion and expectedIssueStatusVersion read from the current case/task. Agent transfers also need toAgentId and phase; terminal completion uses to:done with no toAgentId. A successful agent handoff, including a self-handoff, ends your turn; do not mark the task done and do not call paperclip_finish after it. The harness will yield and wake the next agent.",
    "Only the final revision phase may finish the task. Do not use shell commands, private endpoints, external services or direct filesystem writes; keep findings in task documents.",
  ].join("\n\n");
}
