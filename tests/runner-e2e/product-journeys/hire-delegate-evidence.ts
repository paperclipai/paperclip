import { isDeepStrictEqual } from "node:util";
import { JourneyError } from "./types.js";

type Row = Record<string, any>;
export const HIRE_DELEGATE_JOURNEY = "hire-delegate-reuse" as const;
export function hireDelegateNames(campaignId: string) {
  return { project: `Journey QA hire-delegate-reuse ${campaignId}`, hire: `Morgan Reviewer ${campaignId}`,
    checklist: `Checklist ${campaignId}`, review: `Review ${campaignId}` };
}
export interface HireScope {
  companyId: string; leadId: string; chatId: string; projectId: string; campaignId: string;
  model: string; provider: string; environmentId: string; connectionBinding: unknown;
  connectionChoice?: HireConnectionChoice;
}
export interface HireConnectionChoice {
  connectionId: string; grantId: string; provider: string; method: string; responsibleUserId: string;
}
export async function readHireConnectionChoice(api: { get<T = Row>(route: string): Promise<T> },
  input: { companyId: string; responsibleUserId: string; binding: unknown; hiredId?: string }): Promise<HireConnectionChoice | undefined> {
  const binding = input.binding as Row | undefined;
  if (binding?.mode !== "delegated") return;
  const fail = (): never => { throw new JourneyError("failed", "hire_connection_choice_mismatch"); };
  if (![binding.connectionId, binding.grantId, binding.provider, binding.method, input.responsibleUserId]
    .every(value => typeof value === "string" && value)) fail();
  const listed = await api.get<Row>(`/api/companies/${input.companyId}/ai-connections`);
  if (listed.currentUserId !== input.responsibleUserId || !Array.isArray(listed.connections)
    || listed.connections.some((row: Row) => !row || row.companyId !== input.companyId)) fail();
  const defaults = listed.connections.filter((row: Row) => row.provider === binding.provider && row.isDefault === true);
  const selected = defaults[0];
  if (defaults.length !== 1 || selected.companyId !== input.companyId || selected.id !== binding.connectionId
    || selected.grantId !== binding.grantId || selected.method !== binding.method || selected.status !== "connected"
    || selected.ownership !== "personal" || selected.ownerUserId !== input.responsibleUserId || selected.unavailableReason) fail();
  if (input.hiredId) {
    const installed = await api.get<Row>(`/api/tool-connections/${binding.connectionId}/installs`);
    if (installed.connectionId !== binding.connectionId || !Array.isArray(installed.installs)
      || installed.installs.some((row: Row) => row.companyId !== input.companyId)
      || installed.installs.filter((row: Row) => row.targetType === "agent" && row.targetId === input.hiredId).length !== 1) fail();
  }
  return { connectionId: binding.connectionId, grantId: binding.grantId, provider: binding.provider,
    method: binding.method, responsibleUserId: input.responsibleUserId };
}

function approvedFallback(scope: HireScope, hiredBinding: unknown) {
  const binding = scope.connectionBinding as Row | undefined, choice = scope.connectionChoice;
  return binding?.mode === "delegated" && choice && choice.connectionId === binding.connectionId && choice.grantId === binding.grantId
    && choice.provider === binding.provider && choice.method === binding.method && typeof choice.responsibleUserId === "string"
    && Boolean(choice.responsibleUserId) && isDeepStrictEqual(hiredBinding,
      { provider: choice.provider, method: choice.method, mode: "responsible_user" });
}
export const hireRunIssueId = (run: Row) => run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;

/** A full newest-first page is complete for these runs only if it reaches their start. */
export function assertHireAuditCoverage(activity: Row[], leadRuns: Row[]) {
  if (!Array.isArray(activity) || activity.length > 500) throw new JourneyError("failed", "hire_activity_coverage_unavailable");
  if (activity.length < 500) return;
  if (!leadRuns.length) return; // No native actor exists yet; observation will poll again.
  const starts = leadRuns.map(run => Date.parse(run.startedAt ?? run.createdAt));
  const oldest = Math.min(...activity.map(event => Date.parse(event.createdAt)));
  if (!starts.every(Number.isFinite) || !Number.isFinite(oldest) || oldest > Math.min(...starts)) {
    throw new JourneyError("failed", "hire_activity_coverage_unavailable");
  }
}

/** Exclude unrelated work in a persistent company; require the real native actor's audit. */
export function observedHireResources<A extends Row, T extends Row>(scope: HireScope, state: { agents: A[]; tasks: T[]; activity: Row[]; leadRuns: Row[] }) {
  const names = hireDelegateNames(scope.campaignId);
  const authored = (row: Row, actions: string[]) => state.activity.some(event => event.companyId === scope.companyId
    && event.actorType === "agent" && event.actorId === scope.leadId && event.agentId === scope.leadId
    && event.entityId === row.id && actions.includes(event.action)
    && state.leadRuns.some(run => run.id === event.runId && run.agentId === scope.leadId
      && run.companyId === scope.companyId && hireRunIssueId(run) === scope.chatId));
  const agents = state.agents.filter(agent => authored(agent, ["agent.hire_created", "agent.created"]));
  const tasks = state.tasks.filter(task => authored(task, ["issue.created", "issue.child_created"]));
  const ownable = (row: Row, name: unknown) => row.companyId === scope.companyId && typeof row.id === "string" && row.id
    && typeof name === "string" && Boolean(name);
  const ownedAgents = agents.filter(agent => ownable(agent, agent.name)), ownedTasks = tasks.filter(task => ownable(task, task.title));
  // Persist proven same-company creations before grading their manager/project.
  // Foreign or malformed rows are never owned, and still make the journey fail.
  return { agents: ownedAgents, tasks: ownedTasks, hires: ownedAgents.filter(agent => agent.name === names.hire),
    expectedTasks: ownedTasks.filter(task => [names.checklist, names.review].includes(task.title)),
    scopeMismatch: state.activity.some(event => [...agents, ...tasks].some(row => row.id === event.entityId)
      && state.leadRuns.some(run => run.id === event.runId && run.contextSnapshot?.wakeReason === "chat_task_completed"))
      || agents.some(agent => !ownable(agent, agent.name) || agent.reportsTo !== scope.leadId)
      || tasks.some(task => !ownable(task, task.title) || task.projectId !== scope.projectId) };
}
export function assertHireBinding(scope: HireScope, agents: Row[], hiredId?: string) {
  const names = hireDelegateNames(scope.campaignId);
  const hires = agents.filter(agent => agent.name === names.hire);
  if (agents.length !== 1 || hires.length !== 1) throw new JourneyError("failed", "exactly_one_native_hire_required");
  const hired = hires[0]!;
  if (hired.id === scope.leadId || hiredId && hired.id !== hiredId || hired.companyId !== scope.companyId
    || hired.reportsTo !== scope.leadId || hired.adapterType !== "paperclip_runner" || hired.adapterConfig?.model !== scope.model
    || !scope.connectionBinding || (!isDeepStrictEqual(hired.runtimeConfig?.aiConnection, scope.connectionBinding)
      && !approvedFallback(scope, hired.runtimeConfig?.aiConnection))) {
    throw new JourneyError("failed", "hire_native_binding_mismatch");
  }
  return hired;
}
export function assertHireRuns(scope: HireScope, hiredId: string | undefined, tasks: Row[], runs: Row[], count?: number, requestedCommentIds?: string[], comments?: Row[]) {
  const bindings = new Map([[scope.chatId, scope.leadId], ...tasks.map(task => [task.id, hiredId] as [string, string | undefined])]);
  if (runs.length > 7 || count !== undefined && runs.length !== count || new Set(runs.map(run => run.id)).size !== runs.length) {
    throw new JourneyError("failed", "hire_run_limit_mismatch");
  }
  const requests = new Set<string>(), deliveries = new Set<string>(), completedTasks = new Set<string>();
  let callbackCount = 0, completionRepliesReady = true;
  for (const run of runs) {
    const issueId = hireRunIssueId(run), provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
    if (!bindings.has(issueId) || !bindings.get(issueId) || run.companyId !== scope.companyId || run.agentId !== bindings.get(issueId)) {
      throw new JourneyError("failed", "hire_run_scope_mismatch");
    }
    if (requestedCommentIds && run.agentId === scope.leadId) {
      const context = run.contextSnapshot ?? {};
      if (context.wakeReason === "chat_task_completed") {
        callbackCount++;
        const ids = context.chatCompletionDeliveryIds, updates = context.chatCompletionUpdates;
        if (callbackCount > 2 || run.invocationSource !== "automation" || run.triggerDetail !== "system"
          || context.wakeSource !== "automation" || context.wakeTriggerDetail !== "system" || context.wakeCommentId
          || !Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0] || deliveries.has(ids[0])) {
          throw new JourneyError("failed", "hire_completion_binding_mismatch");
        }
        deliveries.add(ids[0]);
        // Admission freezes exact completed task facts; a queued run has not yet
        // received that projection. Successful callbacks must have it.
        if (run.status === "succeeded" || updates !== undefined) {
          if (!Array.isArray(updates) || updates.length !== 1 || updates[0]?.status !== "done"
            || !tasks.some(task => task.id === updates[0]?.id && task.status === "done") || completedTasks.has(updates[0].id)) {
            throw new JourneyError("failed", "hire_completion_binding_mismatch");
          }
          if (run.status === "succeeded" && comments) {
            const replies = comments.filter(comment => comment.createdByRunId === run.id);
            if (replies.some(comment => comment.companyId !== scope.companyId || comment.issueId !== scope.chatId
              || comment.authorAgentId !== scope.leadId || comment.authorUserId)) throw new JourneyError("failed", "hire_completion_reply_mismatch");
            // Terminal state is persisted before response.add_comment. Missing
            // materialization is pending; a different author/binding is not.
            if (!replies.some(comment => typeof comment.body === "string" && comment.body.trim())) completionRepliesReady = false;
          }
          completedTasks.add(updates[0].id);
        }
      } else {
        if (context.source !== "issue.comment" || !requestedCommentIds.includes(context.wakeCommentId)
          || requests.has(context.wakeCommentId) || requests.size >= 3) throw new JourneyError("failed", "hire_requested_turn_mismatch");
        requests.add(context.wakeCommentId);
      }
    }
    if (!["queued", "running", "succeeded"].includes(run.status)) throw new JourneyError("failed", "hire_native_run_failed");
    if (run.status === "succeeded" && (run.runtimeMode !== "native" || provider?.kind !== scope.provider || provider?.model !== scope.model
      || run.contextSnapshot?.paperclipEnvironment?.id !== scope.environmentId)) throw new JourneyError("failed", "hire_run_runtime_mismatch");
    if (run.status === "succeeded" && scope.connectionChoice) {
      const actual = run.contextSnapshot?.aiConnection, expected = scope.connectionChoice;
      if (actual?.connectionId !== expected.connectionId || actual.grantId !== expected.grantId
        || actual.provider !== expected.provider || actual.method !== expected.method || actual.responsibleUserId !== expected.responsibleUserId
        || !(run.agentId === scope.leadId ? actual.mode === "delegated" : ["delegated", "responsible_user"].includes(actual.mode))) {
        throw new JourneyError("failed", "hire_run_credential_mismatch");
      }
    }
  }
  if (requestedCommentIds && count !== undefined && (requests.size !== requestedCommentIds.length
    || callbackCount !== tasks.length || completedTasks.size !== tasks.length)) throw new JourneyError("failed", "hire_turn_accounting_mismatch");
  if (count !== undefined && !completionRepliesReady) throw new JourneyError("failed", "hire_completion_reply_missing");
  return completionRepliesReady;
}
export function assertHireDocument(scope: HireScope, task: Row, document: Row, revisions: Row[], runs: Row[], marker: string, hiredId: string) {
  const work = runs.filter(run => hireRunIssueId(run) === task.id);
  const revision = revisions.find(row => row.id === document.latestRevisionId);
  if (task.companyId !== scope.companyId || task.assigneeAgentId !== hiredId || task.status !== "done" || task.projectId !== scope.projectId
    || work.length !== 1 || work[0]?.status !== "succeeded" || document.issueId !== task.id || document.companyId !== scope.companyId
    || document.key === "plan" || !document.body?.includes(marker) || !revision || revision.body !== document.body
    || revision.createdByAgentId !== hiredId || revision.createdByRunId !== work[0]?.id) {
    throw new JourneyError("failed", "hired_document_provenance_mismatch");
  }
}
