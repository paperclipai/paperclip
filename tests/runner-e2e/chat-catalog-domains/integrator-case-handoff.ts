import { waitCaseCancellationAccounting } from "./integrator-case-prerequisites.js";
import { randomUUID } from "node:crypto";
import type { cases } from "../../../packages/db/src/schema/cases.js";
import type { CaseHandoff, HandoffCaseResult } from "../../../packages/shared/src/case-handoffs.js";
import type { IssueDocument, DocumentRevision } from "../../../packages/shared/src/types/issue.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
type OwnedTask = Entity & { executionRunId?: string | null; checkoutRunId?: string | null };
const resources = new WeakMap<ChatCatalogContext, { experimental: boolean; gate?: Awaited<ReturnType<typeof startRunBriefGate>> }>();
interface HandoffObservation extends InternalObservation { caseRecord: CaseRecord; handoffs: CaseHandoff[]; findings: IssueDocument; findingVersions: DocumentRevision[]; sourceReplies: Entity[]; sourceIssueId?: string; actingAgent: Pick<Agent, "id" | "name" | "role">; reviewer: Pick<Agent, "id" | "name" | "role"> }
async function cleanup(ctx: ChatCatalogContext) { const value = resources.get(ctx); if (!value) return; try { await value.gate?.close(); } finally { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: value.experimental }); resources.delete(ctx); } }
async function observeHandoff(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<HandoffObservation> {
  const base = await observeInternal(ctx, state); const row = state.case as CaseRecord; const id = (state.task as Entity).id;
  const [acting, reviewer] = await Promise.all([ctx.input.api.get<Agent>(`/api/agents/${base.leadId}`), ctx.input.api.get<Agent>(`/api/agents/${(state.reviewer as Entity).id}`)]);
  return { ...base, sourceIssueId: ctx.issue()?.id, caseRecord: await ctx.input.api.get<CaseRecord>(`/api/cases/${row.id}`),
    actingAgent: { id: acting.id, name: acting.name, role: acting.role }, reviewer: { id: reviewer.id, name: reviewer.name, role: reviewer.role },
    handoffs: (await ctx.input.api.get<{ items: CaseHandoff[] }>(`/api/cases/${row.id}/handoffs?limit=100`)).items,
    findings: await ctx.input.api.get<IssueDocument>(`/api/issues/${id}/documents/findings`), findingVersions: await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${id}/documents/findings/revisions`),
    sourceReplies: ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [] };
}
function handoffObservation(value: unknown): HandoffObservation | undefined { const o = value as HandoffObservation; return observation(value) && !!o.caseRecord && Array.isArray(o.handoffs) && !!o.findings && Array.isArray(o.findingVersions) && Array.isArray(o.sourceReplies) && !!o.actingAgent && !!o.reviewer ? o : undefined; }
function checkoutObservations(body: string) {
  const parts = body.split(/\n+|;|(?<=[.!?])\s+/);
  return /mobile Safari/i.test(body) && parts.some(part => /\b(?:tap|tapping|touch)\b/i.test(part) && /\b(?:Pay|checkout|button)\b/i.test(part)
    && /\b(?:no effect|no response|fails?|unresponsive|nothing|not responsive)\b|\b(?:does not|doesn't)\s+(?:respond|work|activate|trigger|submit|produce)\b/i.test(part)
    && !/\b(?:does not|doesn't|never|not)\s+(?:fail|unresponsive)\b|\bno (?:failure|issue)\b/i.test(part))
    && parts.some(part => /keyboard/i.test(part) && /\b(?:succeeds?|successful|works?|responds?)\b/i.test(part) && !/\b(?:not|fails?|doesn't|does not)\b/i.test(part));
}
export function gradeIntegratorCaseHandoff(value: unknown) {
  const c = checks(); const o = handoffObservation(value); c.add("real-owner-primary-and-handoff-evidence", !!o, "Requires actual Morgan respondent, original primary, saved finding revisions and real handoff source execution."); if (!o) return c.result();
  const original = o.state.case as CaseRecord; const primary = o.tasks.find(task => task.id === original?.workIssueId); const riley = o.state.reviewer as Entity;
  const initial = o.state.findings as IssueDocument; const stoppedTask = o.state.interruptedTask as OwnedTask;
  const stopped = o.runs.find(run => run.id === o.state.interruptedRunId);
  c.add("genuine-morgan-findings-before-human-direction", o.actingAgent.id === o.leadId && o.actingAgent.name === "Morgan" && o.actingAgent.role === "engineer" && o.state.respondentId === o.leadId && stopped?.agentId === o.leadId && stopped.status === "cancelled"
    && stopped.contextSnapshot?.issueId === primary?.id && stoppedTask?.executionRunId === stopped.id && stoppedTask.assigneeAgentId === o.leadId
    && o.findingVersions.some(revision => revision.id === initial?.latestRevisionId && revision.body === initial.body && revision.issueId === primary?.id && revision.createdByAgentId === o.leadId && revision.createdByRunId === stopped.id),
  "The real responding Morgan saved the genuine primary-task finding revision before an actual operator stop released its checkout; no fixture status or roleplay substitutes.");
  const handoff = o.handoffs.find(row => row.version === 2); const primaryRun = o.runs.find(run => run.id === handoff?.sourceRunId);
  c.add("one-same-primary-real-morgan-to-riley", o.handoffs.length === 2 && !!handoff && o.caseRecord.id === original.id && o.caseRecord.workIssueId === original.workIssueId
    && handoff.issueId === primary?.id && handoff.actorType === "agent" && handoff.actorId === o.leadId && handoff.fromAgentId === o.leadId && handoff.toAgentId === riley?.id
    && /review/i.test(handoff.phase) && primary?.assigneeAgentId === riley.id && o.reviewer.id === riley.id && o.reviewer.name === "Riley" && o.tasks.length === 1,
  "One new review handoff changes the eligible owner of the original ordinary primary task, preserving case identity and creating no replacement task.");
  c.add("normal-primary-execution-authority", !!primaryRun && primaryRun.agentId === o.leadId && primaryRun.contextSnapshot?.issueId === primary?.id && primaryRun.status === "succeeded"
    && primaryRun.contextSnapshot?.issueId !== o.sourceIssueId
    && o.runs.some(run => run.agentId === o.leadId && run.contextSnapshot?.issueId === o.sourceIssueId && !!run.startedAt && !!primaryRun.startedAt && Date.parse(String(primaryRun.startedAt)) >= Date.parse(String(run.startedAt))),
  "The source Morgan chat routes the explicit request to a genuinely admitted primary Morgan execution, whose normal JWT/checkout authority performs the handoff.");
  c.add("saved-findings-carried-forward", !!handoff && checkoutObservations(handoff.instructions) && checkoutObservations(initial?.body ?? "")
    && o.findings.issueId === primary?.id && o.findingVersions.some(revision => revision.id === initial?.latestRevisionId),
  "The review instructions retain the saved observed mobile Safari checkout findings, and the original task-owned revision remains inspectable.");
  const reviewRun = o.runs.find(run => run.agentId === riley?.id && run.contextSnapshot?.issueId === primary?.id);
  c.add("review-through-normal-admission-not-case-closure", reviewRun?.status === "succeeded" && reviewRun.runtimeMode === "native" && primary?.status === "done"
    && ["delivered", "completed"].includes(handoff?.state ?? "") && o.caseRecord.status !== "done",
  "Riley's review runs through ordinary native admission on that same task. Completing review alone does not fabricate terminal case closure.");
  const first = handoffObservation(o.state.handoffCheckpoint);
  const firstReply = first?.sourceReplies.filter(comment => comment.authorAgentId === o.leadId).at(-1);
  const claimsDelivered = /\b(?:handed|transferred|assigned|sent)\b[^.!?\n]{0,50}\bRiley\b/i.test(first?.reply ?? "")
    && !/\b(?:not yet|pending|queued|will|request(?:ed)?|waiting)\b/i.test(first?.reply ?? "");
  c.add("no-fictional-immediate-handoff", !!first && (!claimsDelivered || !!handoff && !!firstReply?.createdAt && Date.parse(String(handoff.createdAt)) <= Date.parse(firstReply.createdAt)),
  "An early pending/resume acknowledgement is allowed; a claim of delivered handoff must already be supported when that actual chat reply was saved.");
  return c.result();
}
export const integratorCaseHandoffCases = [integratorDefinition("cases", "cases.handoff-same-task", async ctx => {
  const settings = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental"); resources.set(ctx, { experimental: settings.enableCases });
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: true });
    const p = await project(ctx, "Launch"); const reviewer = await fixtureWorker(ctx); await ctx.input.api.patch(`/api/agents/${reviewer.id}`, { name: "Riley", title: "Case reviewer", capabilities: "Reviews the same ordinary case task using saved findings; completes review without inventing terminal case closure." });
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[ctx.input.fixtures.agent.id, reviewer.id].map(scopeId => ({ scopeType: "agent", scopeId }))])
      await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const gate = await startRunBriefGate(ctx, ctx.input.fixtures.agent.id); resources.get(ctx)!.gate = gate;
    const kickoff = await ctx.input.api.post<HandoffCaseResult>(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, {
      idempotencyKey: `morgan-primary-${ctx.input.nonce}`, case: { create: { caseType: "customer", title: "Mobile checkout investigation", projectId: p.id, fields: { browser: "mobile Safari", observed: "Tapping Pay does nothing; keyboard activation succeeds" } } }, toAgentId: ctx.input.fixtures.agent.id, phase: "investigation",
      instructions: "Read the saved customer observations and save a document with key findings on this ordinary task, keeping observation distinct from an unproven root cause. Then call the connected Website Brief read_website_brief tool to wait for the remaining source evidence. Do not complete or hand off this investigation until the person's next direction.",
      workflow_document_text: `# Owners and review\nMorgan investigates this same ordinary primary task and saves findings. Riley (${reviewer.id}) is the eligible next reviewer. A later explicit human review request must preserve this task and its findings. Case handoff authority belongs to the actual primary task execution. Riley reviews the saved findings, saves a review comment, and marks this review task done without a terminal case handoff. Case closure requires a later explicit accepted-fix decision.`,
      initialDocuments: [{ key: "brief", title: "Customer observations", body: "Synthetic test observations: on mobile Safari, tapping the checkout Pay button has no effect. Activating the same button using a keyboard succeeds. These are observations, not proof of a specific JavaScript root cause." }],
    });
    const phase = await pollUntil({ label: "genuine Morgan saved findings and source wait", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: async () => ({ task: await ctx.input.api.get<OwnedTask>(`/api/issues/${kickoff.taskId}`), documents: await ctx.input.api.get<IssueDocument[]>(`/api/issues/${kickoff.taskId}/documents`), runs: await ctx.allRuns() }),
      accept: value => value.runs.length === 1 && value.task.executionRunId === value.runs[0]?.id && value.runs[0]?.status === "running" && value.documents.some(doc => doc.key === "findings") && gate.calls.some(call => call.authorized) });
    const findings = await ctx.input.api.get<IssueDocument>(`/api/issues/${kickoff.taskId}/documents/findings`);
    const revisions = await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${kickoff.taskId}/documents/findings/revisions`);
    if (!revisions.some(revision => revision.id === findings.latestRevisionId && revision.createdByRunId === phase.runs[0]!.id && revision.createdByAgentId === ctx.input.fixtures.agent.id)) throw new Error("Morgan prerequisite findings have no actual native revision provenance");
    await ctx.input.api.post(`/api/heartbeat-runs/${phase.runs[0]!.id}/cancel`, { cancellationRequestId: randomUUID() });
    await pollUntil({ label: "actual Morgan stop releases ordinary primary ownership", deadlineAt: Date.now() + 90_000, intervalMs: 1000,
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<OwnedTask>(`/api/issues/${kickoff.taskId}`) }),
      accept: value => value.runs.length === 1 && value.runs[0]?.status === "cancelled" && value.task.status === "in_progress" && !value.task.executionRunId && !value.task.checkoutRunId });
    gate.release();
    await waitCaseCancellationAccounting(ctx, { companyId: ctx.input.fixtures.company.id, agentId: ctx.input.fixtures.agent.id, issueId: kickoff.taskId, runId: phase.runs[0]!.id });
    return { project: p, reviewer: { id: reviewer.id, name: "Riley" }, respondentId: ctx.input.fixtures.agent.id, task: await ctx.input.api.get<OwnedTask>(`/api/issues/${kickoff.taskId}`),
      case: await ctx.input.api.get<CaseRecord>(`/api/cases/${kickoff.caseId}`), findings, interruptedTask: phase.task, interruptedRunId: phase.runs[0]!.id };
  } catch (error) { await cleanup(ctx); throw error; }
}, observeHandoff, gradeIntegratorCaseHandoff, async (ctx, state) => {
  const task = state.task as Entity; const row = state.case as CaseRecord;
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, task.title!);
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/cases/${row.identifier}`, row.title);
}, { sourceFiles: ["chat-catalog-domains/integrator-case-handoff.ts", "chat-catalog-domains/internal-run-brief.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/cases.yaml"],
  respondingAgent: { kind: "case-primary-owner", name: "Morgan", role: "engineer", canAssignTasks: true },
  expectedRunCount: 4, attemptTimeoutMs: 900_000, runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 3 } },
  async act(ctx, state) {
    const first = await pollUntil({ label: "actual Morgan source reply and normal primary continuation", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: () => observeHandoff(ctx, state), accept: o => o.runs.some(run => run.agentId === o.leadId && run.contextSnapshot?.issueId === o.sourceIssueId && run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
    state.handoffCheckpoint = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-morgan-review-direction.json", state.handoffCheckpoint);
  }, cleanup,
})];
