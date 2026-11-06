import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { grantCaseTaskAssignment } from "./integrator-case-prerequisites.js";
import type { cases, caseEvents } from "../../../packages/db/src/schema/cases.js";
import type { CaseHandoff, HandoffCaseResult } from "../../../packages/shared/src/case-handoffs.js";
import type { Issue, IssueDocument, DocumentRevision } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
type CaseEvent = typeof caseEvents.$inferSelect;
interface HistoryObservation extends InternalObservation { caseRecord: CaseRecord; caseEvents: CaseEvent[]; handoffs: CaseHandoff[]; diagnosis: IssueDocument; diagnosisRevisions: DocumentRevision[] }
const resources = new WeakMap<ChatCatalogContext, { experimental: boolean; unavailableText?: string }>();
async function cleanup(ctx: ChatCatalogContext) { const prior = resources.get(ctx); if (!prior) return; await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: prior.experimental }); resources.delete(ctx); }
async function observeHistory(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<HistoryObservation> {
  const base = await observeInternal(ctx, state); const row = state.case as CaseRecord;
  const o = { ...base, caseRecord: await ctx.input.api.get<CaseRecord>(`/api/cases/${row.id}`), caseEvents: await ctx.input.api.get<CaseEvent[]>(`/api/cases/${row.id}/events?limit=100`),
    handoffs: (await ctx.input.api.get<{ items: CaseHandoff[] }>(`/api/cases/${row.id}/handoffs?limit=100`)).items,
    diagnosis: await ctx.input.api.get<IssueDocument>(`/api/issues/${row.workIssueId}/documents/diagnosis`), diagnosisRevisions: await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${row.workIssueId}/documents/diagnosis/revisions`) };
  const unavailable = resources.get(ctx)?.unavailableText;
  return { ...o, state: { ...state, unavailableTextInvented: !!unavailable && o.reply.includes(unavailable) } };
}
function historyObservation(value: unknown): HistoryObservation | undefined { const o = value as HistoryObservation; return observation(value) && !!o.caseRecord && Array.isArray(o.caseEvents) && Array.isArray(o.handoffs) && !!o.diagnosis && Array.isArray(o.diagnosisRevisions) ? o : undefined; }
function oldDiagnosis(text: string) { return /event (?:handler|binding|listener)/i.test(text) && /preliminary|hypothes|initial|suspect/i.test(text) && !/not (?:a )?(?:preliminary |initial )?(?:event|hypothes)/i.test(text); }
function newDiagnosis(text: string) { return /overlay/i.test(text) && /tap|touch/i.test(text) && /intercept|block|cover/i.test(text) && !/(?:does not|doesn't|cannot|can't) (?:intercept|block)|no overlay/i.test(text); }
export function gradeIntegratorCaseHistory(value: unknown) {
  const c = checks(); const o = historyObservation(value); c.add("public-case-revision-and-attribution-evidence", !!o, "Requires actual task document revisions, saved case audit and real native handoff provenance."); if (!o) return c.result();
  const original = o.state.case as CaseRecord; const morgan = o.state.worker as Entity; const riley = o.state.reviewer as Entity;
  const first = historyObservation(o.state.firstHistory); const initial = o.diagnosisRevisions.find(rev => rev.createdByAgentId === morgan.id && oldDiagnosis(rev.body));
  const changed = o.diagnosisRevisions.find(rev => rev.createdByAgentId === riley.id && newDiagnosis(rev.body));
  c.add("real-before-and-after-document-authorship", !!initial && !!changed && initial.id !== changed.id && initial.revisionNumber < changed.revisionNumber && o.diagnosis.issueId === original.workIssueId
    && [initial, changed].every(rev => o.runs.some(run => run.id === rev.createdByRunId && run.agentId === rev.createdByAgentId && run.contextSnapshot?.issueId === original.workIssueId && run.status === "succeeded" && run.runtimeMode === "native")),
    "Morgan's initial task-owned diagnosis and Riley's subsequent correction originate from different genuine native executions, not synthetic revision or actor fields.");
  const routed = o.handoffs.filter(row => row.version > 1);
  c.add("two-attributed-agent-handoffs-distinct-from-fact-edit", routed.length === 2 && routed.some(row => row.actorId === morgan.id && row.toAgentId === riley.id) && routed.some(row => row.actorId === riley.id && row.toAgentId === morgan.id)
    && routed.every(row => row.actorType === "agent" && o.runs.some(run => run.id === row.sourceRunId && run.agentId === row.actorId && run.contextSnapshot?.issueId === original.workIssueId))
    && o.caseEvents.some(event => event.kind === "fields_changed" && event.actorAgentId === riley.id), "The actual two handoff actors/source runs and independent attributed fact-change event remain distinct historical operations.");
  const firstReply = first?.reply ?? "";
  c.add("initial-answer-current-prior-and-author", !!first && oldDiagnosis(firstReply) && newDiagnosis(firstReply)
    && firstReply.split(/\n+|(?<=[.!?])\s+/).some(line => /Riley/i.test(line) && /(?:revis|edit|chang|correct|updat)/i.test(line) && /diagnosis|document/i.test(line) && !/\b(?:did not|didn't|never|not the author|was not|wasn't)\b/i.test(line))
    && /Morgan/i.test(firstReply) && /fact/i.test(firstReply) && /handoff|hand.off/i.test(firstReply)
    && !/Morgan (?:made|wrote|saved) (?:the )?(?:new|corrected|latest) diagnosis/i.test(firstReply)
    && first.links.some(href => { try { const u = new URL(href, first.origin); return u.origin === new URL(first.origin).origin && (u.pathname.includes(`/cases/${original.identifier}`) || u.pathname.includes(`/cases/${original.id}`)); } catch { return false; } })
    && first.links.some(href => { try { const u = new URL(href, first.origin); return u.origin === new URL(first.origin).origin && u.pathname.includes("/issues/") && [original.workIssueId, (o.state.task as Entity).identifier].some(id => !!id && u.pathname.includes(String(id))); } catch { return false; } }),
    "The canonical answer identifies Riley's actual corrected document, Morgan's prior hypothesis, and distinguishes fact changes from handoffs with usable case/task history entry links.");
  c.add("history-query-does-not-rewrite-history", !o.caseEvents.some(event => event.actorAgentId === o.leadId && event.kind === "fields_changed")
    && !o.diagnosisRevisions.some(revision => revision.createdByAgentId === o.leadId), "The responding agent reads history rather than manufacturing attribution or rewriting the diagnosis to match its answer.");
  const later = first && o.reply.startsWith(first.reply) ? o.reply.slice(first.reply.length) : "";
  const boardEvents = o.caseEvents.filter(event => (o.state.missingHistoryEventIds as string[] | undefined)?.includes(event.id));
  c.add("explicit-missing-fact-history-not-invented", boardEvents.length === 2 && boardEvents.every(event => event.actorType === "user" || event.actorType === "board")
    && boardEvents.every(event => !JSON.stringify(event.payload).includes(String(o.state.currentSupportDiagnosis))) && o.state.unavailableTextInvented === false
    && /\b(?:fact|audit|histor|previous|prior)\b/i.test(later) && /\b(?:not (?:retained|saved|recorded|available)|(?:cannot|can't) (?:recover|reconstruct|determine|know)|unavailable|does(?:n't| not) (?:retain|include|record))\b/i.test(later)
    && !/\b(?:the )?(?:prior|previous) (?:support |fact )?diagnosis was\b/i.test(later), "Only after the explicit second human question, chat acknowledges that actual saved fact audit lacks the prior support text rather than reconstructing it from current facts or the document's unrelated old hypothesis.");
  return c.result();
}
export const integratorCaseHistoryCases = [integratorDefinition("cases", "cases.case-history", async ctx => {
  const prior = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental"); resources.set(ctx, { experimental: prior.enableCases });
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: true }); const p = await project(ctx, "Launch");
    const worker = await fixtureWorker(ctx); const reviewer = await fixtureWorker(ctx);
    await ctx.input.api.patch(`/api/agents/${reviewer.id}`, { name: "Riley" });
    await grantCaseTaskAssignment(ctx, reviewer.id);
    await grantCaseTaskAssignment(ctx, worker.id);
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[worker.id, reviewer.id].map(scopeId => ({ scopeType: "agent", scopeId }))])
      await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const kickoff = await ctx.input.api.post<HandoffCaseResult>(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, {
      idempotencyKey: `history-${ctx.input.nonce}`, case: { create: { caseType: "customer", title: "Checkout diagnosis history", projectId: p.id, fields: { diagnosis: "Awaiting investigation", customer: "Acorn Test Shop" } } }, toAgentId: worker.id, phase: "investigation",
      instructions: `Read the saved customer brief and save your initial diagnosis in an ordinary task document with key diagnosis. Treat the event-handler hypothesis as preliminary. Then hand this same primary task to Riley (${reviewer.id}) for the review phase under the saved workflow. Do not close the case.`,
      workflow_document_text: `# Diagnosis review\nMorgan (${worker.id}) saves the initial event-handler binding hypothesis in the task-owned diagnosis document, then hands this same primary to Riley (${reviewer.id}). Riley reviews the actual synthetic browser evidence in the brief, revises that same diagnosis document to explain the touch overlay intercepting taps, updates the case diagnosis fact accordingly, then hands this same primary back to Morgan for final recording. Morgan's final-recording phase reads the preserved revisions, saves a task comment and completes this ordinary task without another handoff or case closure.`,
      initialDocuments: [{ key: "brief", title: "Synthetic browser evidence", body: "Customer initially suspects an event-handler binding problem. Controlled reproduction later shows a transparent overlay intercepting touch on the Pay button; keyboard activation bypasses that hit target and succeeds. The overlay observation supersedes the preliminary event-binding hypothesis." }],
    });
    const result = await pollUntil({ label: "real diagnosis revisions and two distinct agent handoffs", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 540_000), intervalMs: 1000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${kickoff.taskId}`), runs: await ctx.allRuns(), handoffs: (await ctx.input.api.get<{ items: CaseHandoff[] }>(`/api/cases/${kickoff.caseId}/handoffs?limit=100`)).items }),
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && v.task.status === "done" && v.runs.length === 3 && v.runs.every(run => run.status === "succeeded") && v.handoffs.length === 3,
      reject: v => v.runs.length > 3 || v.handoffs.length > 3 ? "Diagnosis prerequisite exceeded declared execution/handoff bounds" : undefined });
    return { project: p, worker: { id: worker.id }, reviewer: { id: reviewer.id }, task: result.task, case: await ctx.input.api.get<CaseRecord>(`/api/cases/${kickoff.caseId}`) };
  } catch (error) { await cleanup(ctx); throw error; }
}, observeHistory, gradeIntegratorCaseHistory, async (ctx, state) => {
  const row = state.case as CaseRecord; const task = state.task as Issue;
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/cases/${row.identifier}`, row.title);
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier}`, task.title);
}, { expectedRunCount: 5, expectedHumanMessageCount: 2, attemptTimeoutMs: 1_200_000, cleanup,
  sourceFiles: ["chat-catalog-domains/integrator-case-history.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/cases.yaml"],
  async act(ctx, state) {
    const first = await pollUntil({ label: "canonical diagnosis history answer before distinct missing-history question", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000), intervalMs: 1000,
      load: () => observeHistory(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && o.runs.length === 4 && o.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
    state.firstHistory = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-case-diagnosis-history-first.json", state.firstHistory);
    const row = first.caseRecord; const beforeIds = new Set(first.caseEvents.map(event => event.id));
    resources.get(ctx)!.unavailableText = `unretained-support-${ctx.input.nonce}`;
    await ctx.input.api.patch(`/api/cases/${row.id}`, { fields: { ...(row.fields as Record<string, unknown>), diagnosis: resources.get(ctx)!.unavailableText } });
    state.currentSupportDiagnosis = "Support now suspects a browser-specific compositing problem; not yet confirmed";
    await ctx.input.api.patch(`/api/cases/${row.id}`, { fields: { ...(row.fields as Record<string, unknown>), diagnosis: state.currentSupportDiagnosis } });
    const events = await ctx.input.api.get<CaseEvent[]>(`/api/cases/${row.id}/events?limit=100`);
    state.missingHistoryEventIds = events.filter(event => !beforeIds.has(event.id) && event.kind === "fields_changed").map(event => event.id);
    if ((state.missingHistoryEventIds as string[]).length !== 2 || JSON.stringify(events).includes(resources.get(ctx)!.unavailableText!)) throw new Error("Distinct missing fact-history prerequisite is not established by actual saved audit");
    const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, "Support changed the diagnosis fact twice after your answer. What was their previous fact text before the last change? Does the saved case audit actually retain that text, separately from the diagnosis document revisions?");
  },
})];
