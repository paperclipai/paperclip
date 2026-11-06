import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import type { RoutineDetail, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { integratorDefinition, observeInternal, inspectResult } from "./integrator-support.js";
import type { RuntimeAgent } from "./runtime-support.js";
const gates = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof startRunBriefGate>>>();
interface PauseObservation extends InternalObservation { routine: RoutineDetail; invocations: RoutineRunSummary[] }
async function observePause(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<PauseObservation> {
  const base = await observeInternal(ctx, state); const id = (state.routine as RoutineDetail).id;
  return { ...base, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${id}`), invocations: await ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${id}/runs`) };
}
function pauseObservation(value: unknown): PauseObservation | undefined {
  const o = value as PauseObservation; return observation(value) && !!o.routine && Array.isArray(o.invocations) ? o : undefined;
}
export function gradeIntegratorRoutinePause(value: unknown) {
  const c = checks(); const o = pauseObservation(value);
  c.add("actual-history-and-active-invocation", !!o, "Requires saved routine, genuine prior execution and the actual in-flight task checkpoint.");
  if (!o) return c.result();
  const before = o.state.routine as RoutineDetail; const first = pauseObservation(o.state.pauseCheckpoint);
  const prior = o.state.priorInvocation as RoutineRunSummary; const active = o.state.activeInvocation as RoutineRunSummary;
  c.add("future-schedule-paused-without-definition-loss", o.routine.id === before?.id && o.routine.status === "paused" && first?.routine.status === "paused"
    && o.routine.assigneeAgentId === o.leadId && o.routine.description === before.description && o.routine.projectId === before.projectId
    && o.routine.triggers.length === before.triggers.length && before.triggers.some(trigger => trigger.kind === "schedule" && trigger.enabled)
    && o.routine.triggers.every(trigger => before.triggers.some(old => old.id === trigger.id && old.cronExpression === trigger.cronExpression && old.timezone === trigger.timezone)),
  "The supported persisted pause excludes future scheduled dispatch while retaining the same owned routine and its saved trigger definition.");
  const checkpointRun = first?.runs.find(run => run.id === o.state.activeNativeRunId);
  c.add("pause-does-not-cancel-inflight", !!first && checkpointRun?.status === "running" && checkpointRun.agentId === (o.state.worker as Entity)?.id
    && first.tasks.some(task => task.id === active?.linkedIssueId && task.status === "in_progress")
    && /\b(?:paus(?:ed|ing)|disabled|stopped)\b/i.test(first.reply) && /\b(?:running|in.flight|in.progress|underway|active task)\b/i.test(first.reply)
    && !/\b(?:cancelled|canceled|terminated|stopped)\b[^.!?\n]{0,35}\b(?:running|in.flight|task|execution)\b|\b(?:task|execution|work)\b[^.!?\n]{0,25}\b(?:cancelled|canceled|terminated)\b/i.test(first.reply),
  "At the actual response the separately assigned execution is still genuinely running, and chat describes it separately from future schedules.");
  const savedPrior = o.invocations.find(run => run.id === prior?.id); const savedActive = o.invocations.find(run => run.id === active?.id);
  c.add("history-retained-and-inflight-completes-normally", o.invocations.length === 2 && savedPrior?.status === "completed" && savedPrior.linkedIssueId === prior.linkedIssueId
    && savedActive?.status === "completed" && savedActive.linkedIssueId === active.linkedIssueId
    && o.runs.some(run => run.id === o.state.activeNativeRunId && run.status === "succeeded") && o.tasks.some(task => task.id === active.linkedIssueId && task.status === "done"),
  "Both real invocation histories remain accessible and the preexisting in-flight task completes normally after its actual dependency is released.");
  return c.result();
}
export const integratorRoutinePauseCases = [integratorDefinition("routines", "routines.pause-owned", async ctx => {
  const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const routine = await ctx.input.api.post<RoutineDetail>(`/api/companies/${ctx.input.fixtures.company.id}/routines`, { title: "Daily launch summaries", projectId: p.id, assigneeAgentId: ctx.input.fixtures.agent.id,
    description: "Save one short factual Launch summary in a task comment, then complete this summary task. Do not create other work.", concurrencyPolicy: "always_enqueue" });
  // Public manual execution supports a one-invocation assignee override. The
  // routine remains owned by the CEO while this ordinary task runs as Morgan.
  const priorInvocation = await ctx.input.api.post<RoutineRunSummary>(`/api/routines/${routine.id}/run`, { source: "manual", assigneeAgentId: worker.id, idempotencyKey: `prior-pause-${ctx.input.nonce}` });
  await pollUntil({ label: "real completed routine history before pause", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
    load: () => ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${routine.id}/runs`), accept: rows => rows.length === 1 && rows[0]?.status === "completed" });
  const gate = await startRunBriefGate(ctx, worker.id); gates.set(ctx, gate);
  try {
    await ctx.input.api.patch(`/api/routines/${routine.id}`, { description: "This Launch summary is waiting for its current website brief. First call the connected Website Brief app's read_website_brief tool and wait for its real response; do not substitute earlier context. Then save a short summary of the received brief in a task comment and mark this summary task done. Do not create tasks or change routine settings." });
    const activeInvocation = await ctx.input.api.post<RoutineRunSummary>(`/api/routines/${routine.id}/run`, { source: "manual", assigneeAgentId: worker.id, idempotencyKey: `active-pause-${ctx.input.nonce}` });
    const phase = await pollUntil({ label: "actual routine task waiting for source brief", deadlineAt: Date.now() + 150_000, intervalMs: 1000,
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<Entity>(`/api/issues/${activeInvocation.linkedIssueId}`) }),
      accept: value => value.runs.length === 2 && value.task.status === "in_progress" && gate.calls.some(call => call.authorized) && value.runs.some(run => run.contextSnapshot?.issueId === activeInvocation.linkedIssueId && run.status === "running") });
    await ctx.input.api.post(`/api/routines/${routine.id}/triggers`, { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/Chicago", enabled: true });
    return { project: p, worker: { id: worker.id }, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${routine.id}`), priorInvocation, activeInvocation,
      activeNativeRunId: phase.runs.find(run => run.contextSnapshot?.issueId === activeInvocation.linkedIssueId)?.id, gateObserved: gate.calls.some(call => call.authorized) };
  } catch (error) { await gate.close(); gates.delete(ctx); throw error; }
}, observePause, gradeIntegratorRoutinePause, async (ctx, state) => {
  const routine = state.routine as RoutineDetail; await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/routines/${routine.id}/history`, routine.title);
}, { sourceFiles: ["chat-catalog-domains/integrator-routine-pause.ts", "chat-catalog-domains/internal-run-brief.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/routines.yaml"],
  expectedRunCount: 3, attemptTimeoutMs: 720_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "owned-routine-real-active-task"] },
  async verifySetup(ctx, state) {
    const c = checks(); const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const active = (await ctx.allRuns()).find(run => run.id === state.activeNativeRunId);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The real routine owner is ready for the canonical chat.");
    c.add("owned-routine-real-active-task", active?.status === "running" && active.agentId === (state.worker as Entity).id && active.contextSnapshot?.issueId === (state.activeInvocation as RoutineRunSummary).linkedIssueId
      && state.gateObserved === true && (state.routine as RoutineDetail).assigneeAgentId === lead.id, "The saved CEO-owned routine has a genuinely busy separately assigned ordinary invocation.");
    return c.result();
  },
  async act(ctx, state) {
    const checkpoint = await pollUntil({ label: "actual pause reply while invocation remains running", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000), intervalMs: 1000,
      load: () => observePause(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.runs.length === 3 && o.runs.some(run => run.agentId === o.leadId && run.status === "succeeded") && ctx.issue()?.conversationState === "waiting") });
    state.pauseCheckpoint = { ...checkpoint, state: structuredClone(state) };
    await ctx.input.evidence("chat-routine-pause-running-checkpoint.json", state.pauseCheckpoint);
    gates.get(ctx)?.release();
  },
  async cleanup(ctx) { const gate = gates.get(ctx); if (gate) { await gate.close(); gates.delete(ctx); } },
})];
