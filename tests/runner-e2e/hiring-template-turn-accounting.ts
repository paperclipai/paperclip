/** Strict public lifecycle accounting for the bounded hiring-template journey.
 * Three requested CEO turns and two coder executions remain exact. Up to two
 * server completion turns are separately admitted and still count toward costs.
 * Outcome artifacts and source/read coverage are graded by their own checks.
 */
export const HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION = "paperclip.hiring-template-turn-accounting.v2";
const predicateIds = [
  "known-fixture-context",
  "complete-public-run-ledger",
  "exact-five-required-work-turns",
  "successful-native-without-retries",
  "resolved-company-account-and-identity",
  "three-distinct-requested-chat-turns",
  "one-coder-execution-per-known-task",
  "task-origins-are-first-two-requested-turns",
  "bounded-server-completion-receipts",
  "completion-runs-have-attributed-chat-replies",
  "no-notification-created-extra-tasks",
  "completion-turns-only-report-actions",
] as const;
export type HiringTemplateTurnPredicateId = typeof predicateIds[number];
export interface HiringTemplateTurnPredicate { id: HiringTemplateTurnPredicateId; passed: boolean }
export interface HiringTemplateTurnCounts {
  requiredWorkTurns: 5; maximumCompletionTurns: 2; maximumTotalTurns: 7;
  requestedLeadTurns: number; coderTurns: number; completionTurns: number; unclassifiedTurns: number;
  snapshotRunCount: number; actualRunCount: number; costAccountingRunCount: number;
}
export interface HiringTemplateTurnAccountingResult {
  version: typeof HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION;
  counts: HiringTemplateTurnCounts;
  predicates: HiringTemplateTurnPredicate[];
  passed: boolean;
  actionEvidence: HiringCompletionActionEvidence;
}
export interface HiringCompletionActionEvidence {
  status: "verified" | "violated" | "uncomparable"; notificationRuns: number;
  canonicalExecutions: number; matchedNativeApiCalls: number; unknownExecutions: number;
}
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const rows = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : [];
const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const unique = (values: readonly unknown[]) => values.every(present) && new Set(values).size === values.length;
const sameSet = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && unique(a) && unique(b) && a.every(v => b.includes(v));
const date = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const zero = (value: unknown) => value == null || value === 0;
const noList = (value: unknown) => value == null || Array.isArray(value) && value.length === 0;
const context = (run: JsonRecord) => object(run.contextSnapshot);
const accepted = (run: JsonRecord) => rows(run.identityHistory).filter(i => i.status === "accepted");
const dispatchIdentity = (run: JsonRecord, cause: string, user: unknown) => accepted(run).some(i => i.cause === cause
  && i.responsibleUserId === user && !i.messageId && Number.isFinite(date(i.acceptedAt)));

// Compare only public accounting fields; malformed projections fail closed.
function accountingProjection(run: JsonRecord): string | null {
  try {
    return JSON.stringify({ id: run.id, companyId: run.companyId,
      agentId: run.agentId, status: run.status, runtimeMode: run.runtimeMode,
      responsibleUserId: run.responsibleUserId, invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail, startedAt: run.startedAt, finishedAt: run.finishedAt,
      retryOfRunId: run.retryOfRunId, processLossRetryCount: run.processLossRetryCount,
      scheduledRetryAttempt: run.scheduledRetryAttempt, continuationAttempt: run.continuationAttempt,
      context: Object.fromEntries(["source", "issueId", "wakeReason", "wakeSource", "wakeTriggerDetail", "wakeCommentId",
        "wakeCommentIds", "conversationSessionGeneration", "chatCompletionDeliveryIds", "chatCompletionUpdates"]
        .map(key => [key, context(run)[key]])),
      account: Object.fromEntries(["connectionId", "responsibleUserId", "provider", "method", "mode"]
        .map(key => [key, object(context(run).aiConnection)[key]])),
      identities: rows(run.identityHistory).map(i => Object.fromEntries(["runId", "companyId", "responsibleUserId",
        "status", "cause", "messageId", "acceptedAt"].map(key => [key, i[key]]))) });
  } catch { return null; }
}

const notificationReadApiOperations = new Set([
  "GET /api/issues/{id}", "GET /api/issues/{id}/comments", "GET /api/issues/{id}/documents", "GET /api/issues/{id}/documents/{key}",
]);
const discoveryNames = new Set(["search_api", "search_tasks"]);
const forbiddenWorkTools = new Set(["write_document", "create_task", "hire_agent", "register_deliverable", "create_skill",
  "update_agent_instructions", "restore_agent_instructions", "create_project", "reassign_task", "set_dependencies", "set_task_title"]);
const errored = (value: JsonRecord) => Boolean(value.error || value.is_error || value.isError);
function eventEnvelope(event: JsonRecord) { return object(object(event.payload).prpEvent); }
/** Only exact per-run IDs join provider executions to successful native actions.
 * ACPX host request IDs and provider stream IDs cannot be joined by order/name.
 */
export function gradeHiringCompletionActions(notifications: JsonRecord[], readRuns: unknown): HiringCompletionActionEvidence {
  const ledgers = rows(readRuns);
  const result: HiringCompletionActionEvidence = { status: "verified", notificationRuns: notifications.length,
    canonicalExecutions: 0, matchedNativeApiCalls: 0, unknownExecutions: 0 };
  const unresolved = () => { result.unknownExecutions++; if (result.status !== "violated") result.status = "uncomparable"; };
  const violation = () => { result.status = "violated"; };
  for (const run of notifications) {
    const matching = ledgers.filter(ledger => ledger.runId === run.id && ledger.agentId === run.agentId);
    if (matching.length !== 1) { unresolved(); continue; }
    const events = rows(matching[0]!.events), terminals = events.filter(event => event.eventType === "run.terminal");
    const acceptedResults = events.filter(event => event.eventType === "run.result.accepted");
    const terminalEnvelope = eventEnvelope(terminals[0] ?? {}), terminal = object(terminalEnvelope.payload);
    const acceptedEnvelope = eventEnvelope(acceptedResults[0] ?? {});
    if (!events.length || terminals.length !== 1 || acceptedResults.length !== 1
      || terminalEnvelope.sourceKind !== "control_plane" || terminal.schema !== "paperclip.prp.terminal.v1"
      || terminal.runTerminalState !== "succeeded" || terminal.turnTerminalState !== "completed"
      || acceptedEnvelope.sourceKind !== "control_plane" || object(object(acceptedEnvelope.payload).result).schema !== "paperclip.run_result.v1"
      || !events.every((event, i) => Number.isSafeInteger(event.seq) && event.seq === i + 1)) { unresolved(); continue; }
    const starts = new Map<unknown, JsonRecord>(), completed = new Map<unknown, JsonRecord>();
    const nativeStarts = new Map<unknown, JsonRecord>(), nativeResults = new Map<unknown, JsonRecord>();
    for (const event of events) {
      const envelope = eventEnvelope(event), payload = object(envelope.payload), item = object(payload.item);
      if (event.eventType?.toString().startsWith("tool.execution.")) {
        if (payload.schema !== "paperclip.tool.execution.v1" || !present(payload.executionId)) { unresolved(); continue; }
        if (event.eventType === "tool.execution.started") {
          if (starts.has(payload.executionId)) violation();
          starts.set(payload.executionId, payload);
        } else if (event.eventType === "tool.execution.completed") {
          if (completed.has(payload.executionId) || payload.status !== "completed" || errored(payload)
            || payload.exitCode != null && payload.exitCode !== 0) violation();
          completed.set(payload.executionId, payload);
        } else if (["tool.execution.failed", "tool.execution.cancelled", "tool.execution.interrupted"].includes(String(event.eventType))) violation();
      }
      if (item.type !== "tool_use" && item.type !== "tool_result") continue;
      if (envelope.schema !== "paperclip.prp.event.v1" || envelope.schemaVersion !== 1 || envelope.sourceKind !== "runner"
        || !present(item.id) || errored(item)) { unresolved(); continue; }
      if (event.eventType === "item.started" && item.type === "tool_use") {
        if (nativeStarts.has(item.id)) violation();
        nativeStarts.set(item.id, item);
      } else if (event.eventType === "item.completed" && item.type === "tool_result") {
        if (item.tool_use_id !== item.id || nativeResults.has(item.id) || errored(object(item.result))) violation();
        nativeResults.set(item.id, item);
      } else unresolved();
    }
    if (!sameSet([...starts.keys()], [...completed.keys()]) || !sameSet([...nativeStarts.keys()], [...nativeResults.keys()])) unresolved();
    for (const [id, start] of nativeStarts) {
      const receipt = object(nativeResults.get(id)?.result), input = object(start.input);
      if (start.name === "call_api") {
        if (present(input.operationId) && !notificationReadApiOperations.has(input.operationId)) violation();
        if (!present(input.operationId) || input.operationId !== receipt.apiOperationId || receipt.ok !== true
          || !Number.isInteger(receipt.status) || Number(receipt.status) < 200 || Number(receipt.status) >= 300 || errored(receipt)) { unresolved(); continue; }
        if (!notificationReadApiOperations.has(input.operationId)) violation();
      } else if (start.name === "search_api") {
        if (!Array.isArray(receipt.results) || !Number.isInteger(receipt.total) || Number(receipt.total) < 0 || typeof receipt.guidance !== "string"
          || receipt.nextCursor != null && typeof receipt.nextCursor !== "string") unresolved();
      } else if (start.name === "search_tasks") {
        if (!Array.isArray(receipt.tasks)) unresolved();
      } else if (forbiddenWorkTools.has(String(start.name))) violation();
      else unresolved();
    }
    for (const [id, start] of starts) {
      result.canonicalExecutions++;
      const finish = completed.get(id) ?? {}, native = nativeStarts.get(id);
      if (start.name !== finish.name) { unresolved(); continue; }
      if (forbiddenWorkTools.has(String(start.name))) { violation(); continue; }
      if (start.name === "paperclip_finish") {
        const proposals = events.filter(event => event.eventType === "run.result.proposed");
        const proposal = eventEnvelope(proposals[0] ?? {});
        if (start.transport !== "dynamic" || finish.transport !== "dynamic" || proposals.length !== 1
          || proposal.sourceKind !== "runner" || proposal.itemId !== id
          || object(proposal.payload).schema !== "paperclip.run_result.v1") unresolved();
        continue;
      }
      if (start.name === "ToolSearch" && start.transport === "builtin" && finish.transport === "builtin") continue;
      if (start.name === "call_api" || discoveryNames.has(String(start.name))) {
        if (!native || native.name !== start.name) { unresolved(); continue; }
        if (start.name === "call_api") result.matchedNativeApiCalls++;
      } else if (start.readOnly === true && finish.readOnly === true && ["read", "search", "list"].includes(String(start.operation))
        && start.operation === finish.operation) continue;
      else unresolved();
    }
    // Every native action must also have an exact canonical provider identity.
    if ([...nativeStarts.keys()].some(id => !starts.has(id))) unresolved();
  }
  return result;
}

function evaluate(evidence: unknown, apiState: unknown): HiringTemplateTurnAccountingResult {
  const e = object(evidence), api = object(apiState);
  const chat = object(api.issue), user = chat.conversationUserId, company = chat.companyId;
  const runs = rows(e.runs), publicRuns = rows(api.runs), comments = rows(api.comments);
  const agents = rows(e.agents), tasks = rows(e.tasks), lead = e.leadId;
  const coder = agents.find(a => a.id !== lead && a.name === e.hireName);
  const taskIds = [object(e.first).issueId, object(e.second).issueId];
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const requests = comments.filter(c => c.authorUserId).sort((a, b) => date(a.createdAt) - date(b.createdAt));
  const requested: JsonRecord[] = [], workers: JsonRecord[] = [], notifications: JsonRecord[] = [], unknown: JsonRecord[] = [];
  for (const run of runs) {
    const c = context(run);
    if (run.agentId === lead && c.issueId === e.chatIssueId && c.wakeReason === "issue_commented") requested.push(run);
    else if (run.agentId === coder?.id && taskIds.includes(c.issueId) && c.wakeReason === "issue_assigned") workers.push(run);
    else if (run.agentId === lead && c.issueId === e.chatIssueId && c.wakeReason === "chat_task_completed") notifications.push(run);
    else unknown.push(run);
  }
  const predicates: HiringTemplateTurnPredicate[] = [];
  const check = (id: HiringTemplateTurnPredicateId, passed: unknown) => predicates.push({ id, passed: Boolean(passed) });
  const binding = object(e.binding);
  check("known-fixture-context", present(company) && present(user) && present(lead) && present(coder?.id)
    && chat.id === e.chatIssueId && chat.conversationAgentId === lead
    && typeof chat.conversationSessionGeneration === "number" && Number.isInteger(chat.conversationSessionGeneration) && chat.conversationSessionGeneration >= 0
    && agents.length === 2 && agents.some(a => a.id === lead)
    && unique(agents.map(a => a.id)) && agents.every(a => a.companyId === company)
    && present(e.connectionId) && present(binding.provider) && present(binding.method) && binding.mode === "responsible_user"
    && unique(taskIds) && unique(tasks.map(t => t.id)) && sameSet(taskIds, tasks.map(t => t.id)));
  check("complete-public-run-ledger", sameSet(runs.map(r => r.id), publicRuns.map(r => r.id))
    && runs.every(r => {
      const projection = accountingProjection(r);
      return projection !== null && projection === accountingProjection(publicRuns.find(p => p.id === r.id) ?? {});
    }));
  check("exact-five-required-work-turns", requested.length === 3 && workers.length === 2 && unknown.length === 0
    && notifications.length <= 2 && runs.length === 5 + notifications.length && runs.length <= 7);
  check("successful-native-without-retries", runs.length > 0 && runs.every(r => r.status === "succeeded"
    && r.runtimeMode === "native" && Number.isFinite(date(r.startedAt)) && Number.isFinite(date(r.finishedAt))
    && date(r.finishedAt) >= date(r.startedAt) && !r.retryOfRunId && zero(r.processLossRetryCount)
    && zero(r.scheduledRetryAttempt) && zero(r.continuationAttempt)));
  check("resolved-company-account-and-identity", runs.length > 0 && runs.every(r => {
    const account = object(context(r).aiConnection), identities = accepted(r);
    return r.companyId === company && r.responsibleUserId === user && account.responsibleUserId === user
      && account.connectionId === e.connectionId && ["provider", "method", "mode"].every(k => account[k] === binding[k])
      && identities.length > 0 && identities.every(i => i.responsibleUserId === user
        && i.runId === r.id && i.companyId === company);
  }));
  check("three-distinct-requested-chat-turns", requests.length === 3 && unique(requests.map(c => c.id))
    && sameSet(requested.map(r => context(r).wakeCommentId), requests.map(c => c.id))
    && requests.every(c => c.companyId === company && c.issueId === chat.id && c.authorUserId === user
      && !c.authorAgentId && present(c.body) && Number.isFinite(date(c.createdAt)))
    && requested.every(r => {
      const c = context(r), comment = requests.find(p => p.id === c.wakeCommentId);
      return r.invocationSource === "on_demand" && r.triggerDetail === "manual" && c.source === "issue.comment"
        && c.wakeSource === "on_demand" && c.wakeTriggerDetail === "manual"
        && c.conversationSessionGeneration === chat.conversationSessionGeneration
        && noList(c.chatCompletionDeliveryIds) && noList(c.chatCompletionUpdates)
        && sameSet(Array.isArray(c.wakeCommentIds) ? c.wakeCommentIds : [], [c.wakeCommentId])
        && comment && date(r.startedAt) >= date(comment.createdAt)
        && dispatchIdentity(r, "issue_commented", user)
        && accepted(r).some(i => i.cause === "instruction" && i.messageId === c.wakeCommentId
          && i.responsibleUserId === user && Number.isFinite(date(i.acceptedAt)));
    }));
  check("one-coder-execution-per-known-task", tasks.length === 2 && taskIds.every(id => {
    const task = taskById.get(id), matching = workers.filter(r => context(r).issueId === id), run = matching[0] ?? {};
    const c = context(run ?? {});
    return task && matching.length === 1 && task.companyId === company && task.assigneeAgentId === coder?.id
      && task.projectId === e.projectId && !task.parentId && task.status === "done" && task.responsibleUserId === user
      && Number.isFinite(date(task.completedAt)) && date(task.completedAt) >= date(run.startedAt)
      && run.invocationSource === "assignment" && run.triggerDetail === "system"
      && c.source === "paperclip_runner.create_task" && c.wakeSource === "assignment" && c.wakeTriggerDetail === "system"
      && noList(c.chatCompletionDeliveryIds) && noList(c.chatCompletionUpdates)
      && dispatchIdentity(run, "issue_assigned", user);
  }));
  check("task-origins-are-first-two-requested-turns", taskIds.every((id, index) => {
    const task = taskById.get(id), comment = requests[index];
    const run = requested.find(r => context(r).wakeCommentId === comment?.id);
    return task && run && task.createdByAgentId === lead && !task.createdByUserId && task.originRunId === run.id
      && date(task.createdAt) >= date(run.startedAt);
  }));
  const deliveryIds = new Set<unknown>(), notifiedTasks = new Set<unknown>();
  check("bounded-server-completion-receipts", notifications.every(r => {
    const c = context(r), ids = Array.isArray(c.chatCompletionDeliveryIds) ? c.chatCompletionDeliveryIds : [];
    const updates = rows(c.chatCompletionUpdates);
    let valid = r.invocationSource === "automation" && r.triggerDetail === "system"
      && c.wakeSource === "automation" && c.wakeTriggerDetail === "system" && !c.source
      && c.conversationSessionGeneration === chat.conversationSessionGeneration
      && !c.wakeCommentId && noList(c.wakeCommentIds)
      && ids.length > 0 && ids.length <= 2 && ids.length === updates.length && unique(ids)
      && ids.every(id => !deliveryIds.has(id)) && dispatchIdentity(r, "chat_task_completed", user);
    for (const update of updates) {
      const task = taskById.get(update.id);
      valid = Boolean(valid && task && !notifiedTasks.has(update.id) && update.status === "done"
        && task.status === "done" && update.identifier === task.identifier && update.completedAt === task.completedAt
        && present(task.identifier) && update.url === `/issues/${task.identifier}` && update.hasSavedDocuments === true
        && date(r.startedAt) >= date(task.completedAt));
      notifiedTasks.add(update.id);
    }
    ids.forEach(id => deliveryIds.add(id));
    return valid;
  }));
  check("completion-runs-have-attributed-chat-replies", notifications.every(r => {
    const updates = rows(context(r).chatCompletionUpdates);
    const completedAt = Math.max(...updates.map(u => date(u.completedAt)));
    return updates.length > 0 && comments.some(c => c.companyId === company && c.issueId === chat.id
      && c.authorAgentId === lead && !c.authorUserId && c.createdByRunId === r.id && present(c.body)
      && (c.conversationSessionGeneration == null || c.conversationSessionGeneration === chat.conversationSessionGeneration)
      && date(c.createdAt) >= completedAt && date(c.createdAt) >= date(r.startedAt));
  }));
  check("no-notification-created-extra-tasks", tasks.length === 2 && tasks.every(t =>
    !notifications.some(r => r.id === t.originRunId)));
  const actionEvidence = gradeHiringCompletionActions(notifications, e.readRuns);
  check("completion-turns-only-report-actions", actionEvidence.status === "verified");
  return {
    version: HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION,
    counts: { requiredWorkTurns: 5, maximumCompletionTurns: 2, maximumTotalTurns: 7,
      requestedLeadTurns: requested.length, coderTurns: workers.length, completionTurns: notifications.length,
      unclassifiedTurns: unknown.length, snapshotRunCount: runs.length, actualRunCount: publicRuns.length,
      costAccountingRunCount: publicRuns.length },
    predicates, actionEvidence, passed: predicates.every(predicate => predicate.passed),
  };
}

/** Accept untrusted evidence observations without needing an existing result. */
export function gradeHiringTemplateTurns(input: { evidence: unknown; apiState: unknown }): HiringTemplateTurnAccountingResult {
  let snapshotRunCount = 0, actualRunCount = 0;
  try {
    const runs = object(object(input).apiState).runs;
    actualRunCount = Array.isArray(runs) ? runs.length : 0;
  } catch { /* An inaccessible public ledger is a failed observation. */ }
  try {
    const runs = object(object(input).evidence).runs;
    snapshotRunCount = Array.isArray(runs) ? runs.length : 0;
  } catch { /* Keep public cost accounting when the evidence is malformed. */ }
  try {
    const value = object(input);
    return evaluate(value.evidence, value.apiState);
  } catch {
    return {
      version: HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION,
      counts: { requiredWorkTurns: 5, maximumCompletionTurns: 2, maximumTotalTurns: 7,
        requestedLeadTurns: 0, coderTurns: 0, completionTurns: 0, unclassifiedTurns: snapshotRunCount,
        snapshotRunCount, actualRunCount, costAccountingRunCount: actualRunCount },
      predicates: predicateIds.map(id => ({ id, passed: false })), passed: false,
      actionEvidence: { status: "uncomparable", notificationRuns: 0, canonicalExecutions: 0, matchedNativeApiCalls: 0, unknownExecutions: 0 },
    };
  }
}
