import type { ChatCatalogCase, ChatCatalogGrade } from "./chat-catalog-contract.js";
import type { ChatIssue, ChatRun } from "./chat-flow.js";
import { isAssigneeChangedUnstartedRun } from "./non-execution-wake.js";
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
/**
 * A queued run that never started and that the server cancelled because its own
 * non-source task reached a terminal status is a task lifecycle event, not a
 * provider failure. Early polling must not stop on it; the run stays in the
 * ledger, and the run-bound and case checks still grade it.
 */
export function chatCatalogNeverStartedTerminalTaskRun(run: ChatRun, source?: ChatIssue): boolean {
  const issueId = taskId(run);
  return run.status === "cancelled" && run.errorCode === "issue_terminal_status" && !run.startedAt
    && record(run.resultJson).stopReason === "issue_terminal_status"
    && typeof issueId === "string" && issueId.length > 0 && issueId !== source?.id;
}
/**
 * A queued run on a non-source task that the server retired because the task
 * changed assignee before the run started. Early polling defers it to the grade
 * instead of reporting a provider failure; it is admitted there only with a
 * successor (see chatCatalogSupersededQueuedRuns). Other cancellations stay failures.
 */
export function chatCatalogReassignedQueuedRun(run: ChatRun, source?: ChatIssue): boolean {
  const issueId = taskId(run);
  return isAssigneeChangedUnstartedRun(run) && typeof issueId === "string" && issueId.length > 0 && issueId !== source?.id;
}
/**
 * The superseded queued run did no provider work, so it is not counted toward
 * the declared provider-run bound. It stays in the raw ledger and evidence, and
 * a case may have at most this many, so create-then-reassign churn still fails.
 */
export const CHAT_CATALOG_MAX_SUPERSEDED_QUEUED_RUNS = 1;
/** Retired queued runs whose task's new assignee actually received a later run on that task. */
export function chatCatalogSupersededQueuedRuns(runs: ChatRun[], source?: ChatIssue): ChatRun[] {
  return runs.filter(run => {
    const created = Date.parse(run.createdAt ?? "");
    return chatCatalogReassignedQueuedRun(run, source) && Number.isFinite(created) && runs.some(other => other.id !== run.id
      && taskId(other) === taskId(run) && other.companyId === run.companyId && other.agentId !== run.agentId
      && !chatCatalogReassignedQueuedRun(other, source) && Date.parse(other.createdAt ?? "") >= created);
  });
}
/** The raw ledger without superseded queued runs: the runs that count as provider work. */
export function chatCatalogProviderRuns(runs: ChatRun[], source?: ChatIssue): ChatRun[] {
  const superseded = new Set(chatCatalogSupersededQueuedRuns(runs, source).map(run => run.id));
  return runs.filter(run => !superseded.has(run.id));
}
/**
 * The product's automatic CEO follow-up on the source chat after a delegated
 * task it created completed (`chat_task_completed`). The person's request was
 * already answered; this later turn may start at any moment after the worker
 * finishes, so a settled source can briefly show it queued or running. Only a
 * lead run on the source whose every completion update names separate work in
 * this ledger qualifies; any other source run must still have succeeded. The
 * server records the updates only while it prepares the already-claimed turn,
 * so a queued run, or a running run that is still being prepared, carries only
 * its saved delivery IDs. It qualifies only while queued or running, woken by
 * automation, after a separate worker run in this ledger succeeded.
 */
export function chatCatalogSourceCompletionFollowUp(run: ChatRun, input: { leadId: string; source?: ChatIssue; runs: ChatRun[] }): boolean {
  const snapshot = record(run.contextSnapshot);
  const updates = Array.isArray(snapshot.chatCompletionUpdates) ? snapshot.chatCompletionUpdates : record(snapshot.paperclipWake).chatCompletionUpdates;
  const work = input.runs.filter(other => other.agentId !== input.leadId && typeof taskId(other) === "string" && taskId(other) !== input.source?.id);
  const workTasks = new Set(work.map(taskId));
  if (!input.source || run.agentId !== input.leadId || taskId(run) !== input.source.id || snapshot.wakeReason !== "chat_task_completed") return false;
  if (updates === undefined || updates === null) {
    const deliveries = snapshot.chatCompletionDeliveryIds;
    return ["queued", "running"].includes(run.status) && snapshot.wakeSource === "automation" && Array.isArray(deliveries) && deliveries.length > 0
      && deliveries.every(id => typeof id === "string" && id.length > 0) && work.some(other => other.status === "succeeded");
  }
  return Array.isArray(updates) && updates.length > 0 && updates.every(update => workTasks.has(record(update).id as string));
}
export function gradeChatCatalogRuns(input: {
  implementation: Pick<ChatCatalogCase, "expectedRunCount" | "minimumRunCount" | "runPolicy"> & CancellationCase;
  companyId: string; leadId: string; source?: ChatIssue; runs: ChatRun[];
  observation?: unknown;
}): ChatCatalogGrade {
  const { implementation: c, source } = input;
  const superseded = chatCatalogSupersededQueuedRuns(input.runs, source);
  const runs = chatCatalogProviderRuns(input.runs, source);
  const checks = [
    { id: "catalog-bounded-native-runs", passed: runs.length >= (c.minimumRunCount ?? c.expectedRunCount) && runs.length <= c.expectedRunCount
      && runs.every(run => run.companyId === input.companyId && run.runtimeMode === "native" && chatCatalogAllowedRunStatuses(c).includes(run.status)),
      detail: "Observed provider runs satisfy declared count, company, native runtime and allowed outcome bounds." },
  ];
  if (superseded.length) checks.push({ id: "catalog-superseded-queued-runs", passed: superseded.length <= CHAT_CATALOG_MAX_SUPERSEDED_QUEUED_RUNS,
    detail: "A queued run retired before it started because its task changed assignee is lifecycle, not provider work, only when the new assignee ran on that task; at most one per case." });
  if (c.expectedCancelledWorkerRun !== undefined || c.runPolicy?.kind === "source-settled-with-active-work" && c.runPolicy.expectedWorkerCancellation !== undefined) {
    let valid = true; try { assertExpectedWorkerCancellation(c); } catch { valid = false; }
    checks.push({ id: "catalog-worker-cancellation-declaration", passed: valid,
      detail: "Only edit-properties may declare the exact independently proved worker reassignment cancellation." });
  }
  if (c.runPolicy?.kind === "terminal-counts") {
    const policy = c.runPolicy, maximum = policy.maximumTerminalStatusCounts ?? {};
    checks.push({ id: "catalog-exact-run-outcomes", passed: Object.entries(policy.terminalStatusCounts).every(([status, count]) => {
      const actual = runs.filter(run => run.status === status).length, upper = maximum[status as keyof typeof maximum] ?? count;
      return actual >= count! && actual <= Math.max(count!, upper);
    }) && Object.keys(maximum).every(status => status in policy.terminalStatusCounts),
      detail: "The independently observed ledger matches every declared successful/cancelled/failed terminal outcome count (or its declared role-bound range)." });
  } else if (c.runPolicy?.kind === "source-settled-with-active-work") {
    const sourceRuns = runs.filter(run => taskId(run) === source?.id);
    const followUps = sourceRuns.filter(run => chatCatalogSourceCompletionFollowUp(run, { leadId: input.leadId, source, runs }));
    const answers = sourceRuns.filter(run => !followUps.includes(run));
    const activeFollowUp = followUps.some(run => ["queued", "running"].includes(run.status));
    const handbacks = runs.filter(run => taskId(run) !== source?.id && run.agentId === input.leadId && run.contextSnapshot?.wakeReason === "case_handoff");
    const workers = runs.filter(run => taskId(run) !== source?.id && !handbacks.includes(run));
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
      && (source.conversationState === "waiting" || source.conversationState === "active" && activeFollowUp)
      && answers.length > 0 && answers.every(run => run.agentId === input.leadId && run.status === "succeeded")
      && followUps.length <= 1 && followUps.every(run => ["queued", "running", "succeeded"].includes(run.status))
      && workers.every(run => typeof taskId(run) === "string" && run.agentId !== input.leadId)
      && workers.filter(run => ["queued", "running"].includes(run.status)).length <= c.runPolicy.maximumActiveWorkerRuns
      && handbacks.length <= (c.runPolicy.maximumLeadCaseHandbackRuns ?? 0) && handbacks.every(run => typeof taskId(run) === "string"),
      detail: "The CEO source is settled; unfinished worker runs are separately task-bound and bounded, and any CEO run outside the source is a declared case handback. At most one product completion follow-up for that separate work may still be in flight on the source. The case oracle must additionally bind their exact task and assignee." });
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
