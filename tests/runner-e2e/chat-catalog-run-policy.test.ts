import { expect, it } from "vitest";
import { gradeChatCatalogRuns, chatCatalogAllowedRunStatuses, assertExpectedWorkerCancellation, chatCatalogRunStatusAllowed, createChatCatalogFinalRunVerifier } from "./chat-catalog-run-policy.js";
import type { ChatRun } from "./chat-flow.js";
const succeeded: ChatRun = { id: "source-run", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "source" } };
const worker: ChatRun = { id: "worker-run", companyId: "company", agentId: "worker", status: "running", runtimeMode: "native", contextSnapshot: { issueId: "task" } };
const scope = { companyId: "company", leadId: "ceo", source: { id: "source", companyId: "company", title: "Chat", status: "in_review", conversationState: "waiting" } };
it("requires successful native work by default and exact declared cancellation counts", () => {
  expect(gradeChatCatalogRuns({ ...scope, implementation: { expectedRunCount: 1 }, runs: [succeeded] }).passed).toBe(true);
  const cancelled = { ...succeeded, status: "cancelled" };
  expect(gradeChatCatalogRuns({ ...scope, implementation: { expectedRunCount: 1 }, runs: [cancelled] }).passed).toBe(false);
  const implementation = { expectedRunCount: 1, runPolicy: { kind: "terminal-counts" as const, terminalStatusCounts: { cancelled: 1 } } };
  expect(gradeChatCatalogRuns({ ...scope, implementation, runs: [cancelled] }).passed).toBe(true);
  expect(gradeChatCatalogRuns({ ...scope, implementation, runs: [succeeded] }).passed).toBe(false);
});
it("admits declared separate active work while rejecting active CEO, wrong scope, unbound and excess work", () => {
  const implementation = { expectedRunCount: 2, runPolicy: { kind: "source-settled-with-active-work" as const, maximumActiveWorkerRuns: 1 } };
  expect(gradeChatCatalogRuns({ ...scope, implementation, runs: [succeeded, worker] }).passed).toBe(true);
  for (const bad of [{ ...succeeded, status: "running" }, { ...worker, companyId: "other" }, { ...worker, contextSnapshot: {} }, { ...worker, agentId: "ceo" }])
    expect(gradeChatCatalogRuns({ ...scope, implementation, runs: [succeeded, bad] }).passed).toBe(false);
  expect(gradeChatCatalogRuns({ ...scope, implementation, runs: [succeeded, worker, { ...worker, id: "extra" }] }).passed).toBe(false);
});

function reassignment() {
  const receipt = { runId: "worker-run", taskId: "task", workerId: "worker", sourceRunId: "final-source" };
  const stopped: ChatRun = { ...worker, status: "cancelled", errorCode: "issue_reassigned", resultJson: {
    reassignmentStopConfirmed: true, nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: "worker-run", issueId: "task", companyId: "company", dispatchState: "acknowledged", acknowledgedAt: "2026-10-27T10:00:00Z", intentAuditId: "intent", acknowledgementAuditId: "ack" },
  } };
  const implementation = { scenarioId: "tasks.edit-properties", expectedRunCount: 4, minimumRunCount: 3,
    runPolicy: { kind: "source-settled-with-active-work" as const, maximumActiveWorkerRuns: 1, expectedWorkerCancellation: "owned-task-reassignment" as const },
    expectedCancelledWorkerRun: (observation: unknown) => (observation as { proofComplete?: boolean } | undefined)?.proofComplete ? receipt : undefined };
  const observation = { proofComplete: true, state: { heldRun: { ...worker }, heldTask: { id: "task", companyId: "company", assigneeAgentId: "worker", executionRunId: "worker-run" }, riley: { id: "worker" } } };
  return { implementation, stopped, receipt, observation, runs: [succeeded, { ...succeeded, id: "final-source" }, stopped] };
}
it("defers only the declared worker cancellation during polling and requires final independent proof", () => {
  const v = reassignment();
  expect(chatCatalogAllowedRunStatuses(v.implementation)).toContain("cancelled");
  expect(chatCatalogRunStatusAllowed({ ...scope, implementation: v.implementation, run: v.stopped, observation: { ...v.observation, proofComplete: false } })).toBe(true);
  for (const run of [{ ...v.stopped, id: "other" }, { ...v.stopped, agentId: "ceo" }, { ...v.stopped, companyId: "foreign" }, { ...v.stopped, errorCode: "user_cancelled" }])
    expect(chatCatalogRunStatusAllowed({ ...scope, implementation: v.implementation, run, observation: v.observation })).toBe(false);
  expect(gradeChatCatalogRuns({ ...scope, implementation: v.implementation, runs: v.runs }).passed).toBe(false);
  expect(gradeChatCatalogRuns({ ...scope, implementation: v.implementation, runs: v.runs, observation: v.observation }).passed).toBe(true);
  // No cancellation remains a valid genuine ownership-denied branch; no proof is invented.
  expect(gradeChatCatalogRuns({ ...scope, implementation: v.implementation, runs: [succeeded, { ...succeeded, id: "final-source" }, worker] }).passed).toBe(true);
});
it("rejects wrong cancellation identities, scope, reason, acknowledgement and unrelated cancelled work", () => {
  const mutations = [
    (v: ReturnType<typeof reassignment>) => { v.receipt.runId = "unrelated"; },
    (v: ReturnType<typeof reassignment>) => { v.receipt.taskId = "other-task"; },
    (v: ReturnType<typeof reassignment>) => { v.receipt.workerId = "other-worker"; },
    (v: ReturnType<typeof reassignment>) => { v.receipt.sourceRunId = "unrelated-source"; },
    (v: ReturnType<typeof reassignment>) => { v.stopped.companyId = "foreign"; },
    (v: ReturnType<typeof reassignment>) => { v.stopped.agentId = "ceo"; },
    (v: ReturnType<typeof reassignment>) => { v.stopped.errorCode = "user_cancelled"; },
    (v: ReturnType<typeof reassignment>) => { v.stopped.resultJson!.reassignmentStopConfirmed = false; },
    (v: ReturnType<typeof reassignment>) => { (v.stopped.resultJson!.nativeCancellation as Record<string, unknown>).dispatchState = "pending"; },
    (v: ReturnType<typeof reassignment>) => { (v.stopped.resultJson!.nativeCancellation as Record<string, unknown>).issueId = "other-task"; },
    (v: ReturnType<typeof reassignment>) => { v.runs.push({ ...v.stopped, id: "another-cancelled-run" }); },
  ];
  for (const mutate of mutations) { const v = reassignment(); mutate(v); expect(gradeChatCatalogRuns({ ...scope, implementation: v.implementation, runs: v.runs, observation: v.observation }).passed).toBe(false); }
});
it("requires exact scenario/flag/callback and leaves every undeclared active-work case unchanged", () => {
  const v = reassignment();
  expect(() => assertExpectedWorkerCancellation(v.implementation)).not.toThrow();
  for (const implementation of [
    { ...v.implementation, scenarioId: "tasks.assignment-conflict" },
    { ...v.implementation, expectedCancelledWorkerRun: undefined },
    { ...v.implementation, runPolicy: { kind: "source-settled-with-active-work" as const, maximumActiveWorkerRuns: 1 } },
  ]) { expect(() => assertExpectedWorkerCancellation(implementation)).toThrow(); expect(gradeChatCatalogRuns({ ...scope, implementation, runs: v.runs, observation: v.observation }).passed).toBe(false); }
  expect(chatCatalogAllowedRunStatuses({ runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 } })).not.toContain("cancelled");
});

it("binds cancellation proof presence through the actual lazy registry loader", async () => {
  const { loadChatCatalogImplementation } = await import("./chat-catalog-registry.js");
  const v = reassignment(); const { expectedCancelledWorkerRun, ...metadata } = v.implementation;
  const descriptor = { ...metadata, modulePath: "./chat-catalog-domains/internal-tasks.js", exportName: "cases", sourceFiles: ["chat-catalog-domains/internal-edit-ownership.ts"], oracleVersion: "test", turnTimeoutMs: 120_000, attemptTimeoutMs: 600_000 };
  const implementation = { ...descriptor, expectedCancelledWorkerRun, setup: async () => ({}), observe: async () => ({}), grade: () => ({ passed: true, checks: [{ id: "actual-proof", passed: true, detail: "Fixture-only registry control" }] }), verifyResult: async () => {} };
  await expect(loadChatCatalogImplementation(descriptor, async () => ({ cases: [implementation] }))).resolves.toBe(implementation);
  await expect(loadChatCatalogImplementation(descriptor, async () => ({ cases: [{ ...implementation, expectedCancelledWorkerRun: undefined }] }))).rejects.toThrow("cancellation proof");
  const wrongDescriptor = { ...descriptor, scenarioId: "tasks.assignment-conflict" };
  await expect(loadChatCatalogImplementation(wrongDescriptor, async () => ({ cases: [{ ...implementation, scenarioId: wrongDescriptor.scenarioId }] }))).rejects.toThrow("cancellation proof");
});


it("retains the executable cancellation proof at the outer final-run boundary", () => {
  const v = reassignment();
  const verify = createChatCatalogFinalRunVerifier({ implementation: v.implementation, companyId: scope.companyId,
    leadId: scope.leadId, observation: v.observation });
  expect(verify(scope.source, v.runs).passed).toBe(true);
  // JSON declarations cannot replace the executable independent proof callback.
  expect(() => createChatCatalogFinalRunVerifier({ implementation: JSON.parse(JSON.stringify(v.implementation)),
    companyId: scope.companyId, leadId: scope.leadId, observation: v.observation })).toThrow("cancellation proof");
  for (const run of [
    { ...v.stopped, errorCode: "user_cancelled" },
    { ...v.stopped, companyId: "foreign" },
    { ...v.stopped, resultJson: { ...v.stopped.resultJson, nativeCancellation: { ...(v.stopped.resultJson!.nativeCancellation as object), dispatchState: "pending" } } },
  ]) expect(verify(scope.source, v.runs.map(row => row.id === run.id ? run : row)).passed).toBe(false);
  expect(verify(scope.source, [...v.runs, { ...v.stopped, id: "new-cancellation" }]).passed).toBe(false);
  expect(verify({ ...scope.source, id: "different-source" }, v.runs).passed).toBe(false);
});

it("keeps an ordinary ownership-denial boundary strict without a cancellation declaration", () => {
  const implementation = { expectedRunCount: 2,
    runPolicy: { kind: "source-settled-with-active-work" as const, maximumActiveWorkerRuns: 1 } };
  const verify = createChatCatalogFinalRunVerifier({ implementation, companyId: scope.companyId,
    leadId: scope.leadId, observation: undefined });
  expect(verify(scope.source, [succeeded, worker]).passed).toBe(true);
  expect(verify(scope.source, [succeeded, { ...worker, status: "cancelled" }]).passed).toBe(false);
});
