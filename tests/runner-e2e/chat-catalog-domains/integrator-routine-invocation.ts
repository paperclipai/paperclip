import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { createRoutineSchema } from "../../../packages/shared/src/validators/routine.js";
import type { RoutineDetail, RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, hasLink, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { integratorDefinition, observeInternal, inspectResult, resultHref } from "./integrator-support.js";

interface InvocationObservation extends InternalObservation { routine: RoutineDetail; invocations: RoutineRunSummary[]; outputComments: Entity[] }
async function observeInvocation(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<InvocationObservation> {
  const base = await observeInternal(ctx, state); const id = (state.routine as RoutineDetail).id;
  const invocations = await ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${id}/runs`);
  return { ...base, routine: await ctx.input.api.get<RoutineDetail>(`/api/routines/${id}`), invocations,
    outputComments: invocations[0]?.linkedIssueId ? await ctx.input.api.get<Entity[]>(`/api/issues/${invocations[0].linkedIssueId}/comments?order=asc`) : [] };
}
function invocationObservation(value: unknown): InvocationObservation | undefined {
  const o = value as InvocationObservation;
  return observation(value) && !!o.routine && Array.isArray(o.invocations) && Array.isArray(o.outputComments) ? o : undefined;
}
function falseCompletion(reply: string) {
  return /\b(?:summary|execution|task|run)\b[^.!?\n]{0,50}\b(?:completed|finished|succeeded|is ready)\b/i.test(reply)
    && !/\b(?:not|hasn't|has not|isn't|not yet|pending|waiting)\b/i.test(reply);
}
export function gradeIntegratorRoutineInvocation(value: unknown) {
  const c = checks(); const o = invocationObservation(value);
  c.add("actual-invocation-and-output", !!o, "Requires public invocation, task, native output and original response evidence.");
  if (!o) return c.result();
  const invocation = o.invocations[0]; const task = o.tasks.find(row => row.id === invocation?.linkedIssueId);
  const first = invocationObservation(o.state.firstInvocation);
  const firstInvocation = first?.invocations[0];
  c.add("one-manual-launch-input", o.invocations.length === 1 && invocation?.source === "manual" && invocation.routineId === o.routine.id
    && invocation.triggerPayload?.variables != null && (invocation.triggerPayload.variables as Record<string, unknown>).projectName === "Launch"
    && !!task && task.projectId === (o.state.project as Entity | undefined)?.id && task.assigneeAgentId === o.leadId,
  "Exactly one manual invocation retains the supplied project-name input and creates the intended owned Launch task.");
  c.add("same-delivery-is-not-new-intent", !!firstInvocation?.idempotencyKey && o.state.replayRunId === invocation?.id
    && o.state.replayIssueId === task?.id && firstInvocation.id === invocation?.id && o.invocations.length === 1,
  "Replaying the committed public invocation with its original key retains the same invocation and task IDs.");
  c.add("accepted-versus-completed-at-first-reply", !!first && first.invocations.length === 1
    && (!falseCompletion(first.reply) || firstInvocation?.status === "completed" && first.tasks.some(row => row.id === firstInvocation.linkedIssueId && row.status === "done")),
  "The first answer cannot claim a completed summary before the saved invocation and task actually complete.");
  const outputRun = o.runs.find(run => run.contextSnapshot?.issueId === task?.id && run.agentId === o.leadId && run.status === "succeeded" && run.runtimeMode === "native");
  const output = o.outputComments.filter(row => row.authorAgentId === o.leadId && row.createdByRunId === outputRun?.id).map(row => row.body ?? "").join("\n");
  c.add("actual-completed-summary", !!task && invocation?.status === "completed" && task.status === "done" && !!outputRun && /launch/i.test(output)
    && /payment/i.test(output) && /\b(?:pending|waiting|await|approval)\b/i.test(output),
  "The routine's own native task actually saved the Launch summary using the pending payment fact and completed normally.");
  const later = first && o.reply.startsWith(first.reply) ? o.reply.slice(first.reply.length) : "";
  c.add("later-actual-result-and-task-link", !!task && hasLink(o, "issues", task) && /launch/i.test(later) && /payment/i.test(later)
    && /\b(?:pending|waiting|await|approval)\b/i.test(later) && /\b(?:completed|finished)\b|\b(?:summary|result)\b[^.!?\n]{0,25}(?:\b(?:reports?|shows?|contains?|says?|found|is)\b|:)/i.test(later)
    && !/\b(?:failed|not completed|not finished|still running|only accepted|payment (?:is )?approved)\b/i.test(later),
  "The explicit later user request receives the real summary result and its actual execution task, not another acceptance or an invented payment approval.");
  return c.result();
}
/** Validate prerequisite input against the same supported public creation schema. */
export function launchSummaryRoutineInput(projectId: string, assigneeAgentId: string) {
  return createRoutineSchema.parse({ title: "Launch summary", projectId, assigneeAgentId,
    description: "Summarize the actual {{projectName}} project in one saved task comment, including its actual payment approval state. Link the project and mark this summary task done. Do not change project records or create follow-up tasks.",
    variables: [{ name: "projectName", type: "text", required: true }] });
}
export const integratorRoutineInvocationCases = [integratorDefinition("routines", "routines.run-now", async ctx => {
  const p = await project(ctx, "Launch", { description: "Synthetic Launch project. Payment approval is pending; no approval has been received." });
  const routine = await ctx.input.api.post<RoutineDetail>(`/api/companies/${ctx.input.fixtures.company.id}/routines`, launchSummaryRoutineInput(p.id, ctx.input.fixtures.agent.id));
  return { project: p, routine };
}, observeInvocation, gradeIntegratorRoutineInvocation, async (ctx, _state, value) => {
  const o = invocationObservation(value); const task = o?.tasks.find(row => row.id === o.invocations[0]?.linkedIssueId);
  if (!o || !task) throw new Error("Missing actual routine result task");
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, task.title!, resultHref(o, task.identifier ?? task.id, "issues") ?? resultHref(o, task.id, "issues"));
}, {
  sourceFiles: ["chat-catalog-domains/integrator-routine-invocation.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/routines.yaml"],
  expectedRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    const first = await pollUntil({ label: "routine invocation first actual reply", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000), intervalMs: 1000,
      load: () => observeInvocation(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.invocations.length === 1 && o.runs.some(row => row.agentId === o.leadId && row.contextSnapshot?.issueId === ctx.issue()?.id && row.status === "succeeded") && ctx.issue()?.conversationState === "waiting"),
      reject: o => o.invocations.length > 1 ? "Initial request created duplicate routine invocations" : undefined });
    state.firstInvocation = { ...first, state: structuredClone(state) };
    const invocation = first.invocations[0]!;
    if (!invocation.idempotencyKey || !invocation.linkedIssueId) throw new Error("Committed routine invocation has no replayable public identity");
    // Independent transport-delivery probe of the existing committed request;
    // it must not supply another user intent or admit another execution.
    const replay = await ctx.input.api.post<RoutineRunSummary>(`/api/routines/${invocation.routineId}/run`, {
      source: invocation.source, triggerId: invocation.triggerId, idempotencyKey: invocation.idempotencyKey,
      payload: invocation.triggerPayload, variables: invocation.triggerPayload?.variables,
    });
    state.replayRunId = replay.id; state.replayIssueId = replay.linkedIssueId;
    await ctx.input.evidence("chat-routine-invocation-first-response.json", state.firstInvocation);
    await pollUntil({ label: "real routine execution completed", deadlineAt: Date.now() + 240_000, intervalMs: 1000,
      load: () => observeInvocation(ctx, state), accept: o => o.invocations.length === 1 && o.invocations[0]?.status === "completed" && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded"),
      reject: o => o.invocations.length > 1 || o.runs.length > 2 ? "Delivery replay admitted unexpected additional work" : undefined });
    const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, "What was the actual result of that summary run?", chatCatalogNativePhaseRemainingBudget(ctx));
  },
})];
