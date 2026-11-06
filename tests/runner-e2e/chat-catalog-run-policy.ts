import type { ChatCatalogCase, ChatCatalogGrade } from "./chat-catalog-contract.js";
import type { ChatIssue, ChatRun } from "./chat-flow.js";
type CancellationCase = Pick<ChatCatalogCase, "runPolicy"> & Partial<Pick<ChatCatalogCase, "scenarioId" | "expectedCancelledWorkerRun">>;
export function assertExpectedWorkerCancellation(implementation: CancellationCase) {
  const flag = implementation.runPolicy?.kind === "source-settled-with-active-work"
    ? implementation.runPolicy.expectedWorkerCancellation : undefined;
  if (flag === undefined ? implementation.expectedCancelledWorkerRun !== undefined
    : flag !== "owned-task-reassignment" || implementation.scenarioId !== "tasks.edit-properties" || typeof implementation.expectedCancelledWorkerRun !== "function")
    throw new Error("Missing or undeclared exact task-reassignment cancellation proof");
}
function permitsReassignment(implementation: CancellationCase) {
  return implementation.scenarioId === "tasks.edit-properties" && implementation.runPolicy?.kind === "source-settled-with-active-work"
    && implementation.runPolicy.expectedWorkerCancellation === "owned-task-reassignment" && typeof implementation.expectedCancelledWorkerRun === "function";
}
export function chatCatalogAllowedRunStatuses(implementation: CancellationCase): string[] {
  const policy = implementation.runPolicy;
  return policy?.kind === "terminal-counts" ? Object.keys(policy.terminalStatusCounts)
    : policy?.kind === "source-settled-with-active-work" ? ["queued", "running", "succeeded", ...(permitsReassignment(implementation) ? ["cancelled"] : [])] : ["succeeded"];
}
const taskId = (run: ChatRun) => (run as ChatRun & { nativeIssueId?: string }).nativeIssueId ?? run.contextSnapshot?.issueId;
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
/** Early polling can defer only the saved, independently held worker, never a source or unrelated cancellation. */
export function chatCatalogRunStatusAllowed(input: {
  implementation: CancellationCase; run: ChatRun; companyId: string; leadId: string; source?: ChatIssue; observation?: unknown;
}): boolean {
  const { implementation, run } = input;
  if (run.status !== "cancelled" || !permitsReassignment(implementation)) return chatCatalogAllowedRunStatuses(implementation).includes(run.status);
  const state = record(record(input.observation).state), held = record(state.heldRun), task = record(state.heldTask), worker = record(state.riley);
  return held.id === run.id && held.status === "running" && held.companyId === input.companyId && held.agentId === worker.id
    && run.companyId === input.companyId && run.agentId === worker.id && run.agentId !== input.leadId
    && task.companyId === input.companyId && task.assigneeAgentId === worker.id && task.executionRunId === run.id
    && task.id === taskId(run) && task.id !== input.source?.id && run.errorCode === "issue_reassigned";
}
export function gradeChatCatalogRuns(input: {
  implementation: Pick<ChatCatalogCase, "expectedRunCount" | "minimumRunCount" | "runPolicy"> & CancellationCase;
  companyId: string; leadId: string; source?: ChatIssue; runs: ChatRun[];
  observation?: unknown;
}): ChatCatalogGrade {
  const { implementation: c, runs, source } = input;
  const checks = [
    { id: "catalog-bounded-native-runs", passed: runs.length >= (c.minimumRunCount ?? c.expectedRunCount) && runs.length <= c.expectedRunCount
      && runs.every(run => run.companyId === input.companyId && run.runtimeMode === "native" && chatCatalogAllowedRunStatuses(c).includes(run.status)),
      detail: "Observed provider runs satisfy declared count, company, native runtime and allowed outcome bounds." },
  ];
  if (c.expectedCancelledWorkerRun !== undefined || c.runPolicy?.kind === "source-settled-with-active-work" && c.runPolicy.expectedWorkerCancellation !== undefined) {
    let valid = true; try { assertExpectedWorkerCancellation(c); } catch { valid = false; }
    checks.push({ id: "catalog-worker-cancellation-declaration", passed: valid,
      detail: "Only edit-properties may declare the exact independently proved worker reassignment cancellation." });
  }
  if (c.runPolicy?.kind === "terminal-counts") {
    checks.push({ id: "catalog-exact-run-outcomes", passed: Object.entries(c.runPolicy.terminalStatusCounts).every(([status, count]) => runs.filter(run => run.status === status).length === count),
      detail: "The independently observed ledger matches every declared successful/cancelled/failed terminal outcome count." });
  } else if (c.runPolicy?.kind === "source-settled-with-active-work") {
    const sourceRuns = runs.filter(run => taskId(run) === source?.id);
    const workers = runs.filter(run => taskId(run) !== source?.id);
    const cancelled = runs.filter(run => run.status === "cancelled");
    const declared = permitsReassignment(c);
    let expected: ReturnType<NonNullable<ChatCatalogCase["expectedCancelledWorkerRun"]>>;
    try { expected = declared ? c.expectedCancelledWorkerRun!(input.observation) : undefined; } catch { expected = undefined; }
    const actual = expected && workers.find(run => run.id === expected.runId);
    const acknowledgement = actual?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
    const exact = !!expected && cancelled.length === 1 && cancelled[0]?.id === expected.runId && !!actual
      && chatCatalogRunStatusAllowed({ ...input, run: actual })
      && actual.companyId === input.companyId && actual.agentId === expected.workerId && actual.agentId !== input.leadId
      && taskId(actual) === expected.taskId && expected.taskId !== source?.id && actual.errorCode === "issue_reassigned"
      && actual.resultJson?.reassignmentStopConfirmed === true
      && acknowledgement?.schema === "paperclip.native-cancellation.v1" && acknowledgement.runId === actual.id
      && acknowledgement.issueId === expected.taskId && acknowledgement.companyId === input.companyId
      && acknowledgement.dispatchState === "acknowledged" && typeof acknowledgement.acknowledgedAt === "string" && Number.isFinite(Date.parse(acknowledgement.acknowledgedAt))
      && typeof acknowledgement.intentAuditId === "string" && acknowledgement.intentAuditId.length > 0
      && typeof acknowledgement.acknowledgementAuditId === "string" && acknowledgement.acknowledgementAuditId.length > 0
      && sourceRuns.some(run => run.id === expected.sourceRunId && run.agentId === input.leadId && run.status === "succeeded");
    checks.push({ id: "catalog-exact-owned-worker-cancellation", passed: cancelled.length === 0 ? expected === undefined : declared && exact,
      detail: "Only the exact independently proved task-reassignment cancellation is accepted; final actor, chronology and saved-state proof remains mandatory in the case callback." });
    checks.push({ id: "catalog-settled-source-separate-work", passed: !!source && source.companyId === input.companyId
      && source.conversationState === "waiting" && sourceRuns.length > 0 && sourceRuns.every(run => run.agentId === input.leadId && run.status === "succeeded")
      && workers.every(run => typeof taskId(run) === "string" && run.agentId !== input.leadId)
      && workers.filter(run => ["queued", "running"].includes(run.status)).length <= c.runPolicy.maximumActiveWorkerRuns,
      detail: "The CEO source is settled; unfinished worker runs are separately task-bound and bounded. The case oracle must additionally bind their exact task and assignee." });
  }
  return { passed: checks.every(check => check.passed), checks };
}


export type ChatCatalogFinalRunVerifier = (source: ChatIssue | undefined, runs: ChatRun[]) => ChatCatalogGrade;

/** Preserve the loaded case's proof callback for a fresh outer ledger read. */
export function createChatCatalogFinalRunVerifier(input: {
  implementation: Parameters<typeof gradeChatCatalogRuns>[0]["implementation"];
  companyId: string;
  leadId: string;
  observation: unknown;
}): ChatCatalogFinalRunVerifier {
  assertExpectedWorkerCancellation(input.implementation);
  return (source, runs) => gradeChatCatalogRuns({ ...input, source, runs });
}
