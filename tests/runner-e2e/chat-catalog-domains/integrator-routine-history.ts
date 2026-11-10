import type { RoutineDetail, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, hasLink, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import { prepareHistoryNotes, cleanupHistoryNotes, historyNotesPhase, historyNotesCalls, waitHistoryWork, readHistoryWork, genuineHistoryWork, routineHistoryAccountingReady, completeHistoryUsage, type HistoryWorkIdentity, type HistoryWorkSnapshot, type WorkCall } from "./routine-history-work-failure.js";
export { routineHistoryAccountingReady } from "./routine-history-work-failure.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
interface HistoryObservation extends InternalObservation { expectedProvider: string; routine: RoutineDetail; executions: RoutineRunSummary[] }
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
async function observeHistory(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<HistoryObservation> {
  state.failedWork = await readHistoryWork(ctx, state.failedIdentity as HistoryWorkIdentity);
  state.completedWork = await readHistoryWork(ctx, state.completedIdentity as HistoryWorkIdentity);
  const base = await observeInternal(ctx, state); const routine = state.routine as RoutineDetail;
  return { ...base, expectedProvider: ctx.input.execution.profile.provider, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${routine.id}`), executions: await ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${routine.id}/runs`) };
}
function historyObservation(value: unknown): HistoryObservation | undefined {
  const o = value as HistoryObservation;
  return observation(value) && !!o.routine && Array.isArray(o.executions) ? o : undefined;
}
export function gradeIntegratorRoutineHistory(value: unknown) {
  const c = checks(); const o = historyObservation(value);
  c.add("actual-routine-and-native-execution-history", !!o, "Requires real public invocation history plus distinct actual failed work and successful execution receipts.");
  if (!o) return c.result();
  const failedTask = o.tasks.find(task => task.id === o.state.failedIssueId); const completedTask = o.tasks.find(task => task.id === o.state.completedIssueId);
  const failedInvocation = o.executions.find(run => run.id === o.state.failedInvocationId); const completedInvocation = o.executions.find(run => run.id === o.state.completedInvocationId);
  const failure = o.state.failedWork as HistoryWorkSnapshot | undefined;
  const success = o.state.completedWork as HistoryWorkSnapshot | undefined;
  const failedIdentity = o.state.failedIdentity as HistoryWorkIdentity;
  const completedIdentity = o.state.completedIdentity as HistoryWorkIdentity;
  c.add("genuine-task-bound-failed-work", !!failedTask && genuineHistoryWork(failedIdentity, failure, o.state.failedCalls as WorkCall[] ?? [], true)
    && failedIdentity.companyId === o.companyId && failedIdentity.agentId === (o.state.worker as Entity | undefined)?.id
    && failedIdentity.issueId === failedTask.id && failedIdentity.invocationId === failedInvocation?.id
    && failedTask.status === "blocked" && failedInvocation?.status === "failed" && completeHistoryUsage(failure?.run)
    && o.runs.some(run => run.id === failedIdentity.runId && run.status === "succeeded" && run.companyId === o.companyId && run.agentId === failedIdentity.agentId && run.contextSnapshot?.issueId === failedTask.id)
    && o.state.failedWritten === null, "Actual authorized synthetic MCP work returned HTTP 200/tool_error, with company/worker/task/native-run audit, a worker-blocked task, failed public invocation and complete normal usage. Narration or patched state alone is insufficient.");
  c.add("genuine-recovered-work-and-accounting", genuineHistoryWork(completedIdentity, success, o.state.completedCalls as WorkCall[] ?? [], false)
    && completedIdentity.companyId === o.companyId && completedIdentity.agentId === (o.state.worker as Entity | undefined)?.id
    && completedIdentity.issueId === completedTask?.id && completedIdentity.invocationId === completedInvocation?.id
    && completeHistoryUsage(success?.run) && typeof o.state.completedWritten === "string" && !!o.state.completedWritten,
    "The restored synthetic provider received a separate authorized successful write under the second task/native run, with completed public history and normal usage.");
  c.add("separate-real-successful-invocation", !!completedTask && completedTask.status === "done" && completedInvocation?.status === "completed" && completedInvocation.linkedIssueId === completedTask.id
    && completedTask.id !== failedTask?.id && o.runs.some(run => run.id === o.state.completedNativeRunId && run.status === "succeeded" && run.runtimeMode === "native" && run.contextSnapshot?.issueId === completedTask.id), "A second independently invoked routine actually completed its normal task under a successful native run.");
  const start = Number(o.state.weekStart), end = Number(o.state.weekEnd);
  c.add("requested-week-and-exact-history-retained", [failedInvocation, completedInvocation].every(run => !!run && Date.parse(String(run.triggeredAt)) >= start && Date.parse(String(run.triggeredAt)) < end)
    && o.executions.length === 2 && failedInvocation?.source === "manual" && completedInvocation?.source === "manual", "Both actual manual invocations fall inside the measured current week, with no hidden or duplicate history rows.");
  c.add("actual-failure-and-completion-linked", !!failedTask && !!completedTask && hasLink(o, "issues", failedTask) && hasLink(o, "issues", completedTask), "The answer links both real execution tasks.");
  // The reply's meaning (which run failed, no inferred scheduled success) is free-form text: a person reads it. The oracle
  // grades only what the product recorded and the rendered links above, never reply vocabulary.
  c.add("failed-work-not-inferred-routine-completion", !!failedTask && !!completedTask && failedTask.status === "blocked" && failedInvocation?.status === "failed"
    && completedTask.status === "done" && completedInvocation?.status === "completed",
    "The product records the setup's outcomes: the failed invocation's task is blocked and the completed invocation's task is done.");
  return c.result();
}
export const integratorRoutineHistoryCases = [integratorDefinition("routines", "routines.read-history", async ctx => {
  const p = await project(ctx, "Launch", { description: "Synthetic Launch project: payment approval remains pending; no other active work." }); const worker = await fixtureWorker(ctx);
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }]) await ctx.input.api.post(`${root(ctx)}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const connection = await prepareHistoryNotes(ctx, worker.id);
  const routine = await ctx.input.api.post<RoutineDetail>(`${root(ctx)}/routines`, { title: "Morning Launch summary", projectId: p.id, assigneeAgentId: worker.id, concurrencyPolicy: "always_enqueue",
    description: "Summarize the actual Launch project in a short saved task comment, link the project, and publish that summary once using the connected Synthetic Launch Notes launch_update action. This is a controlled synthetic dependency, not an official vendor service. If the actual publish returns an error, report the actual failure in this task's comment and block the task truthfully; do not mark failed work done. If the publish succeeds, save the result and mark this summary task done. Do not retry, repair the provider, edit project work or create follow-up tasks." });
  const invoke = async (kind: string) => {
    const invocation = await ctx.input.api.post<RoutineRunSummary>(`/api/routines/${routine.id}/run`, { source: "manual", idempotencyKey: `${kind}-history-${ctx.input.nonce}` });
    if (!invocation.linkedIssueId) throw new Error("Routine prerequisite did not admit an actual execution task");
    return { companyId: ctx.input.fixtures.company.id, agentId: worker.id, issueId: invocation.linkedIssueId, routineId: routine.id, invocationId: invocation.id, ...connection };
  };
  const failedBase = await invoke("failed");
  const failure = await waitHistoryWork(ctx, failedBase, true, -1, 150_000);
  const failedIdentity = { ...failedBase, runId: failure.snapshot.run!.id };
  const accounting = await pollUntil({ label: "genuine failed work normal provider accounting before separate success invocation", deadlineAt: Date.now() + 60_000, intervalMs: 1000,
    load: async () => ({ snapshot: await readHistoryWork(ctx, failedBase), overview: await ctx.input.api.get<BudgetOverview>(`${root(ctx)}/budgets/overview`) }),
    accept: value => genuineHistoryWork(failedIdentity, value.snapshot, historyNotesCalls(ctx), true)
      && routineHistoryAccountingReady(failedIdentity, [value.snapshot.run!], value.overview) });
  const failedCalls = historyNotesCalls(ctx); const failedPhase = historyNotesPhase(ctx);
  if (failedPhase.written !== null) throw new Error("Failed synthetic work unexpectedly changed the notes page");
  historyNotesPhase(ctx, true);
  const completedBase = await invoke("success");
  const success = await waitHistoryWork(ctx, completedBase, false, failedPhase.lastSequence, 180_000, true);
  if ((await ctx.allRuns()).length !== 2) throw new Error("Routine history fixture exceeded its two declared real native invocations");
  const weekStart = new Date(); weekStart.setUTCHours(0, 0, 0, 0); weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  return { project: p, worker: { id: worker.id }, routine, failedInvocationId: failedBase.invocationId, completedInvocationId: completedBase.invocationId,
    failedIssueId: failedBase.issueId, completedIssueId: completedBase.issueId, failedIdentity, completedIdentity: { ...completedBase, runId: success.snapshot.run!.id },
    failedWork: accounting.snapshot, completedWork: success.snapshot, failedCalls, completedCalls: success.calls,
    failedWritten: failedPhase.written, completedWritten: historyNotesPhase(ctx).written, completedNativeRunId: success.snapshot.run!.id,
    weekStart: weekStart.getTime(), weekEnd: weekStart.getTime() + 7 * 86400_000 };

}, observeHistory, gradeIntegratorRoutineHistory, async (ctx, state) => {
  const routine = state.routine as RoutineDetail;
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/routines/${routine.id}/history`, routine.title);
}, { sourceFiles: ["chat-catalog-domains/integrator-routine-history.ts", "chat-catalog-domains/routine-history-work-failure.ts", "chat-catalog-domains/external-provider.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/routines.yaml"],
  oracleVersion: "paperclip.chat-catalog.integrator.routine-work-failure.v5", authentication: "human-session", cleanup: cleanupHistoryNotes, expectedRunCount: 3, runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 3 } }, attemptTimeoutMs: 720_000,
})];
