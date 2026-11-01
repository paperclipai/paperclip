import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const CASE_RECEIPT_MAX_TURNS = 4;
export const CASE_RECEIPT_RUN_TIMEOUT_MS = 90_000;
export const CASE_RECEIPT_BUDGET_CENTS = 100;
export type CaseReceiptRole = "triage" | "implementation" | "verification";
export type CaseReceiptAgents = Record<CaseReceiptRole, string>;

export const caseReceiptTask: RunnerTaskFixture = {
  id: "receipt-smoke", label: "Persist, review, and correct one receipt on the same case task", groups: [],
  flow: "case_handoff", workMode: "standard", expectedRunCount: CASE_RECEIPT_MAX_TURNS, minimumExpectedRunCount: CASE_RECEIPT_MAX_TURNS,
  automaticRetryPolicy: "single_attempt", turnTimeoutMs: CASE_RECEIPT_RUN_TIMEOUT_MS,
  attemptTimeoutMs: { local: 5 * 60_000, daytona: 5 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Receipt case smoke ${nonce}`,
  buildPrompt: () => "Build a receipt from the case inputs, persist a review, and correct the receipt on this same task.",
  buildVisibleMarker: nonce => `CASE-RECEIPT-DONE-${nonce}`,
  buildMatchers: () => [],
};

export function caseReceiptDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["case-receipt-cases.ts", "case-receipt-scoring.ts", "case-receipt-flow.ts", "case-handoffs-scoring.ts",
    "native-event-envelope.ts", "codex-subscription-fixture.ts", "live-fixtures.ts", "runner.spec.ts", "launch.ts", "redaction.ts",
    "../../server/src/services/native-runtime/canonical.ts",
    "../../server/src/services/native-runtime/runner-api-log-redaction.ts", "../../server/src/redaction.ts"]) {
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex");
}

/** Role instructions accompany the task's explicit workflow document. */
export function caseReceiptAgentPrompt(role: CaseReceiptRole, agents: CaseReceiptAgents, nonce: string): string {
  const handoff = (agent: string, phase: string, instructions: string) =>
    `Call handoff_case to ${agent}, phase ${phase}, instructions ${JSON.stringify(`${nonce}: ${instructions}`)}.`;
  const common = [
    `Receipt smoke ${nonce}. Use the incoming Workflow case context to identify the current case and primary task; reuse both.`,
    "Read the primary task document workflow with read_document({key:'workflow'}) before deciding what to do in this phase.",
    "Use the native read_case tool with explicit caseId to read current inputs and handoffVersion. Use get_task_context for the current task statusVersion.",
    "Save TASK documents using write_document with {key,title,body:<JSON string>,idempotencyKey:<stable phase key>}. Read with read_document({key}). For an update, read the current document and pass its latestRevisionId as baseRevisionId. These tools return the persisted document and revision metadata.",
    "Before handoff, read the current case and task versions. Supply case:{id}, expectedHandoffVersion, expectedIssueStatusVersion, and a stable phase-specific idempotencyKey. For agent transfers, end the turn when callerMustYield=true. A terminal handoff with to:'done' does not yield; finish the task normally afterward.",
    "Use only native Paperclip tools; do not use generic call_api. No shell, files, repositories, external services, new tasks, new cases, or case status changes. Documents belong to the primary task and appear on the case through references.",
  ];
  const work = role === "triage" ? [
    "You own triage. Read the seeded task document brief with read_document({key:'brief'}), then read the case inputs and confirm items, quantity, unitPrice, and currency are present. Call update_case with caseId, a stable idempotencyKey and fields containing ALL current fields plus inputsValidated:true. Do not create documents or complete the task.",
    handoff(agents.implementation, "implementation", "Calculate the receipt from case inputs, save the first TASK receipt per your instructions, and hand off for verification."),
  ] : role === "verification" ? [
    "You own verification. Read the persisted TASK receipt document. Independently compute sum(quantity*unitPrice) from case inputs; compare the saved total and check required currency. Never infer the saved receipt from handoff prose.",
    "Write TASK document review with JSON {totalCorrect:<actual comparison>,missing:<array of missing required fields>}. Report what you read; do not invent a passing total or missing field. Do not edit receipt or complete the task.",
    handoff(agents.implementation, "revision", "GET the saved TASK review and receipt; correct the missing fields using case inputs, save a receipt revision, and finish this same task."),
  ] : [
    "You own implementation and the returning revision turn. Branch on the current case phase.",
    "For implementation: calculate sum(quantity*unitPrice) from case inputs. Write TASK document receipt with JSON {total:<computed total>}. Intentionally omit currency in this first revision so the reviewer can detect the missing field.",
    handoff(agents.verification, "verification", "GET the persisted TASK receipt, independently check total and required currency, save TASK review, and return this task for revision."),
    `For revision only: read TASK review and receipt. Require totalCorrect=true and missing containing currency; otherwise report the unexpected evidence. Add currency from case inputs while preserving the correct total. Write receipt with its observed baseRevisionId and JSON {total,currency}. Then read the case/task versions and call handoff_case with to:'done', case:{id}, both expected versions, idempotencyKey:'${nonce}-done', and instructions:'${nonce}: Receipt corrected and independently reviewed; finish the case when task completion is accepted.' Finally complete this same task normally using the saved TASK documents as evidence; final response ${caseReceiptTask.buildVisibleMarker(nonce)}.`,
  ];
  return [...common, ...work].join("\n");
}
