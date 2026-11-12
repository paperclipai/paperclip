import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { openStandingChat } from "./identity-support.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { checks, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
interface OwnedTask extends Entity { checkoutRunId?: string | null; executionRunId?: string | null }
interface OwnershipObservation extends InternalObservation { currentTask: OwnedTask; phaseReply: string }
export function gradeTaskOwnership(value: unknown) {
  const c = checks(); const o = observation(value) as OwnershipObservation | undefined;
  c.add("actual-stale-read-and-checkout", !!o && !!o.currentTask && typeof o.phaseReply === "string" && !!o.state.firstRead && !!o.state.heldTask, "An attributed prior CEO read, actual owner assignment change and independently held native checkout are required.");
  if (!o || !o.currentTask || typeof o.phaseReply !== "string") return c.result();
  const first = observation(o.state.firstRead); const before = o.state.task as Entity; const worker = o.state.worker as Entity; const riley = o.state.riley as Entity;
  const held = o.state.heldTask as OwnedTask | undefined; const heldRun = o.state.heldRun as Entity | undefined;
  const oldTask = first?.tasks.find(row => row.id === before?.id);
  c.add("real-ceo-read-precedes-owner-change", !!first && !!oldTask && oldTask.assigneeAgentId === riley?.id && oldTask.status === "backlog"
    && first.reply.includes(String(o.state.readMarker)) && /\bRiley\b/.test(first.reply)
    && first.runs.length === 1 && first.runs[0]?.agentId === o.leadId && first.runs[0]?.status === "succeeded"
    && o.activity.some(row => row.action === "issue.updated" && row.entityId === before?.id && row.actorType === "user" && row.details?.assigneeAgentId === worker?.id),
    "The CEO actually received the old Riley/backlog state and unpredictable brief before a different authenticated actor assigned Morgan.");
  const workerRuns = o.runs.filter(run => run.agentId !== o.leadId);
  c.add("newer-morgan-checkout-not-overwritten", !!held && !!heldRun && held.assigneeAgentId === worker?.id && held.executionRunId === heldRun.id
    && sameTask(held, o.currentTask) && o.currentTask.executionRunId === heldRun.id && o.currentTask.checkoutRunId === held.checkoutRunId
    && Array.isArray(o.state.gateCalls) && (o.state.gateCalls as Array<{ authorized?: boolean }>).some(call => call.authorized)
    && workerRuns.length === 1 && workerRuns[0]?.id === heldRun.id && workerRuns[0]?.agentId === worker?.id && workerRuns[0]?.status === "running"
    && !o.activity.some(row => row.action === "issue.updated" && row.entityId === before?.id && row.agentId === o.leadId),
    "The second CEO turn cannot steal Morgan's real running checkout, admit Riley concurrently or manufacture a workaround task.");
  c.add("no-workaround-task", o.tasks.length === 1 && o.tasks[0]?.id === before?.id, "Only the original task exists after the reassignment request.");
  const falseClaim = o.phaseReply.split(/[.\n;]|,\s*(?:but|and)\s*/).some(part => /\bRiley\b[^.\n]*(?:has (?:begun|started)|is (?:running|working|executing)|now owns)|\b(?:reassigned|moved|assigned)\b[^.\n]*\bto Riley\b/i.test(part)
    && !/\b(?:not|cannot|can't|haven't|hasn't|didn't|pending|denied|until|would|could)\b/i.test(part));
  c.add("truthful-current-boundary", !!before && hasLink(o, "issues", before) && /\bMorgan\b/.test(o.phaseReply)
    && /\b(?:checkout|ownership|running|in.progress|executing|active run)\b/i.test(o.phaseReply)
    && /\b(?:cannot|can't|blocked|conflict|denied|not (?:yet )?(?:reassigned|moved)|must|need|until|wait)\b/i.test(o.phaseReply)
    && !falseClaim,
    "The final phase identifies Morgan's current execution boundary and does not claim Riley has begun or accepted reassignment.");
  return c.result();
}
function assignmentConflict(): ChatCatalogCase {
  let gate: Awaited<ReturnType<typeof startRunBriefGate>> | undefined;
  const base = makeDefinition("tasks.assignment-conflict", async ctx => {
    const worker = await fixtureWorker(ctx); const riley = await fixtureWorker(ctx); await ctx.input.api.patch(`/api/agents/${riley.id}`, { name: "Riley" });
    const p = await project(ctx); const readMarker = `Observed old brief ${ctx.input.nonce}`;
    const t = await task(ctx, "Website task", p.id, { assigneeAgentId: riley.id,
      description: `${readMarker}. Read the authorized Website Brief app's read_website_brief tool before doing any work. Wait for its actual source response; do not invent its contents.` });
    const state: Record<string, unknown> = { project: p, task: t, worker, riley, readMarker };
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[ctx.input.fixtures.agent.id, worker.id].map(id => ({ scopeType: "agent", scopeId: id }))])
      await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    await openStandingChat(ctx); const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, `Read the Website task (${t.identifier ?? t.id}) and report its current assignee, status and brief. Do not change it; wait for my next request.`);
    const first = await pollUntil({ label: "Real CEO read of the older task assignment", deadlineAt: Date.now() + 150_000,
      load: () => observeInternal(ctx, state), accept: o => o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting"
        && o.reply.includes(readMarker) && /\bRiley\b/.test(o.reply) && sameTask(t, o.tasks.find(row => row.id === t.id)) });
    state.firstRead = { ...first, state: structuredClone(state) };
    gate = await startRunBriefGate(ctx, worker.id);
    try {
      await ctx.input.api.patch(`/api/issues/${t.id}`, { assigneeAgentId: worker.id, status: "todo" });
      const held = await pollUntil({ label: "Real new Morgan checkout after the CEO read", deadlineAt: Date.now() + 150_000,
        load: async () => ({ task: await ctx.input.api.get<OwnedTask>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
        accept: value => gate!.calls.length > 0 && value.runs.length === 2 && value.runs.some(run => run.agentId === worker.id && run.status === "running" && run.id === value.task.executionRunId),
        reject: value => value.runs.some(run => run.agentId === worker.id && ["failed", "cancelled", "succeeded", "timed_out"].includes(run.status)) ? "New owner finished before the actual ownership-conflict boundary" : undefined });
      state.heldTask = held.task; state.heldRun = held.runs.find(run => run.agentId === worker.id); state.gateCalls = structuredClone(gate.calls);
      await ctx.input.evidence("chat-catalog-stale-read-then-real-checkout.json", state); return state;
    } catch (error) { await gate.close(); gate = undefined; throw error; }
  }, gradeTaskOwnership);
  return { ...base, expectedRunCount: 3, minimumRunCount: 3, expectedHumanMessageCount: 2, setupHumanMessageCount: 1, attemptTimeoutMs: 600_000,
    runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-task-ownership.ts", "chat-catalog-domains/internal-run-brief.ts", "chat-catalog-domains/identity-support.ts", "../e2e/fetch-allowed-port.ts"],
    async observe(ctx, state): Promise<OwnershipObservation> {
      const o = await observeInternal(ctx, state); const prior = observation(state.firstRead); const firstIds = new Set(prior?.runs.map(run => run.id) ?? []);
      const comments = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
      const phaseReply = comments.filter(row => row.authorAgentId === o.leadId && !firstIds.has(row.createdByRunId ?? "") && o.runs.some(run => run.id === row.createdByRunId)).map(row => row.body ?? "").join("\n");
      return { ...o, phaseReply, currentTask: await ctx.input.api.get<OwnedTask>(`/api/issues/${entity(state, "task").id}`) };
    },
    async cleanup() { await gate?.close(); gate = undefined; },
  };
}
export const taskOwnershipCases: readonly ChatCatalogCase[] = [assignmentConflict()];
