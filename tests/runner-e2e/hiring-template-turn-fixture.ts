// Test-only public lifecycle facts shared by turn and outcome calibrations.
interface FixtureIdentity {
  runId: string; companyId: string; responsibleUserId: string; status: string;
  cause: string; messageId: string | null; acceptedAt: string;
}
interface FixtureUpdate {
  id: string; identifier: string; status: string; completedAt: string;
  url: string; hasSavedDocuments: boolean;
}
interface FixtureRun {
  id: string; companyId: string; agentId: string; responsibleUserId: string;
  invocationSource: string; triggerDetail: string; status: string; runtimeMode: string;
  startedAt: string; finishedAt: string; retryOfRunId: string | null;
  processLossRetryCount: number; scheduledRetryAttempt: number; continuationAttempt: number;
  identityHistory: FixtureIdentity[];
  contextSnapshot: {
    source?: string; issueId: string; wakeReason: string; wakeSource: string;
    wakeTriggerDetail: string; conversationSessionGeneration: number;
    wakeCommentId?: string; wakeCommentIds: string[];
    aiConnection: { provider: string; method: string; mode: string; connectionId: string; responsibleUserId: string };
    chatCompletionDeliveryIds?: string[]; chatCompletionUpdates?: FixtureUpdate[];
  };
  [key: string]: unknown;
}
interface FixtureComment {
  id: string; companyId: string; issueId: string; authorUserId: string | null;
  authorAgentId: string | null; body: string; createdAt: string;
  createdByRunId?: string; conversationSessionGeneration?: number | null;
}
export const hiringTurnFixtureTimestamp = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, seconds)).toISOString();

/** Complete canonical/native read-action stream with one exact execution ID. */
export function hiringNotificationActionEvents() {
  const id = "read-action";
  const payload = { schema: "paperclip.tool.execution.v1", executionId: id, transport: "dynamic",
    operation: "unknown", name: "call_api", readOnly: null, status: "running", exitCode: null };
  const items: Array<{ eventType: string; payload: Record<string, unknown> }> = [
    { eventType: "tool.execution.started", payload },
    { eventType: "item.started", payload: { kind: "tool", item: { id, type: "tool_use", name: "call_api",
      input: { operationId: "GET /api/issues/{id}/documents", pathParams: {} } } } },
    { eventType: "item.completed", payload: { kind: "tool", item: { id, tool_use_id: id, type: "tool_result",
      result: { apiOperationId: "GET /api/issues/{id}/documents", ok: true, status: 200 } } } },
    { eventType: "tool.execution.completed", payload: { ...payload, status: "completed" } },
    { eventType: "run.result.accepted", payload: { result: { schema: "paperclip.run_result.v1" } } },
    { eventType: "run.terminal", payload: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed" } },
  ];
  return items.map((event, i) => ({ seq: i + 1, eventType: event.eventType, payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: event.eventType.startsWith("run.") ? "control_plane" : "runner", payload: event.payload,
  } } }));
}

export function createHiringTemplateTurnFixture(notificationCount = 2) {
  if (!Number.isInteger(notificationCount) || notificationCount < 0 || notificationCount > 2)
    throw new RangeError("The positive lifecycle fixture accepts zero, one or two notification turns.");
  const timestamp = hiringTurnFixtureTimestamp;
  const company = "company", user = "board", lead = "lead", coder = "coder", chat = "chat";
  const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" };
  function run(id: string, agentId: string, issueId: string, reason: string, start: number, finish: number, source?: string): FixtureRun {
    const invocationSource = reason === "issue_commented" ? "on_demand"
      : reason === "issue_assigned" ? "assignment" : "automation";
    const triggerDetail = reason === "issue_commented" ? "manual" : "system";
    return { id, companyId: company, agentId, responsibleUserId: user, invocationSource, triggerDetail,
      status: "succeeded", runtimeMode: "native", startedAt: timestamp(start), finishedAt: timestamp(finish),
      retryOfRunId: null, processLossRetryCount: 0, scheduledRetryAttempt: 0, continuationAttempt: 0,
      identityHistory: [{ runId: id, companyId: company, responsibleUserId: user, status: "accepted",
        cause: reason, messageId: null, acceptedAt: timestamp(start) }],
      contextSnapshot: { source, issueId, wakeReason: reason, wakeSource: invocationSource,
        wakeTriggerDetail: triggerDetail, conversationSessionGeneration: 0, wakeCommentIds: [],
        aiConnection: { ...binding, connectionId: "account", responsibleUserId: user } } };
  }
  const requested = [run("lead-first", lead, chat, "issue_commented", 1, 10, "issue.comment"),
    run("lead-reuse", lead, chat, "issue_commented", 21, 30, "issue.comment"),
    run("lead-status", lead, chat, "issue_commented", 51, 55, "issue.comment")];
  const comments: FixtureComment[] = requested.map((r, i) => {
    const id = `request-${i + 1}`;
    r.contextSnapshot.wakeCommentId = id;
    r.contextSnapshot.wakeCommentIds = [id];
    r.identityHistory.push({ runId: r.id, companyId: company, responsibleUserId: user, status: "accepted",
      cause: "instruction", messageId: id, acceptedAt: r.startedAt });
    return { id, companyId: company, issueId: chat, authorUserId: user, authorAgentId: null,
      body: `Fixture request ${i + 1}`, createdAt: timestamp([0, 20, 50][i]!) };
  });
  const workers = [run("worker-first", coder, "first-task", "issue_assigned", 4, 12, "paperclip_runner.create_task"),
    run("worker-reuse", coder, "second-task", "issue_assigned", 25, 40, "paperclip_runner.create_task")];
  const tasks = workers.map((r, i) => ({ id: r.contextSnapshot.issueId, companyId: company, projectId: "project",
    title: r.contextSnapshot.issueId, parentId: null as string | null, status: "done", identifier: `RUN-${i + 2}`, responsibleUserId: user,
    assigneeAgentId: coder, createdByAgentId: lead, createdByUserId: null as string | null, originRunId: requested[i]!.id,
    createdAt: timestamp([2, 22][i]!), completedAt: timestamp([11, 39][i]!) }));
  const notifications: FixtureRun[] = [];
  for (let i = 0; i < notificationCount; i++) {
    const r = run(`notify-${i + 1}`, lead, chat, "chat_task_completed", notificationCount === 1 ? 41 : [13, 41][i]!,
      notificationCount === 1 ? 45 : [18, 45][i]!);
    const covered = notificationCount === 1 ? tasks : [tasks[i]!];
    r.contextSnapshot.chatCompletionDeliveryIds = covered.map(t => `delivery-${t.id}`);
    r.contextSnapshot.chatCompletionUpdates = covered.map(t => ({ id: t.id, identifier: t.identifier,
      status: "done", completedAt: t.completedAt, url: `/issues/${t.identifier}`, hasSavedDocuments: true }));
    comments.push({ id: `reply-${i + 1}`, companyId: company, issueId: chat, authorAgentId: lead,
      authorUserId: null, createdByRunId: r.id, body: "The saved fixture is complete.",
      conversationSessionGeneration: null, createdAt: r.finishedAt });
    notifications.push(r);
  }
  const runs = [...requested, ...workers, ...notifications];
  const evidence = { leadId: lead, chatIssueId: chat, hireName: "Fixture Coder", projectId: "project", connectionId: "account", binding,
    agents: [{ id: lead, companyId: company, name: "Fixture CEO" }, { id: coder, companyId: company, name: "Fixture Coder" }],
    first: { issueId: tasks[0]!.id }, second: { issueId: tasks[1]!.id }, runs, tasks,
    readRuns: notifications.map(run => ({ runId: run.id, agentId: run.agentId, events: hiringNotificationActionEvents() })) };
  const apiState = { issue: { id: chat, companyId: company, conversationUserId: user,
    conversationAgentId: lead, conversationSessionGeneration: 0 }, comments, runs: structuredClone(runs) };
  return { evidence, apiState };
}
