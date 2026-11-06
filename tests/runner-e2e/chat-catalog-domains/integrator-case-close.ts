import { grantCaseTaskAssignment } from "./integrator-case-prerequisites.js";
import type { cases } from "../../../packages/db/src/schema/cases.js";
import type { CaseHandoff, HandoffCaseResult } from "../../../packages/shared/src/case-handoffs.js";
import type { Issue, IssueDocument, DocumentRevision, IssueBlockerDiagnosticsResponse } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, task, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
interface CloseObservation extends InternalObservation { caseRecord: CaseRecord; handoffs: CaseHandoff[]; finalDocument: IssueDocument; finalRevisions: DocumentRevision[]; negativeCase?: CaseRecord; negativeTask?: Issue; pendingReview?: Issue; blockerEvidence?: IssueBlockerDiagnosticsResponse }
const settings = new WeakMap<ChatCatalogContext, boolean>();
async function cleanup(ctx: ChatCatalogContext) { const value = settings.get(ctx); if (value === undefined) return; await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: value }); settings.delete(ctx); }
async function observeClose(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<CloseObservation> {
  const o = await observeInternal(ctx, state); const row = state.case as CaseRecord;
  return { ...o, caseRecord: await ctx.input.api.get<CaseRecord>(`/api/cases/${row.id}`), handoffs: (await ctx.input.api.get<{ items: CaseHandoff[] }>(`/api/cases/${row.id}/handoffs?limit=100`)).items,
    finalDocument: await ctx.input.api.get<IssueDocument>(`/api/issues/${row.workIssueId}/documents/review`), finalRevisions: await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${row.workIssueId}/documents/review/revisions`),
    ...(state.negativeCase ? { negativeCase: await ctx.input.api.get<CaseRecord>(`/api/cases/${(state.negativeCase as CaseRecord).id}`), negativeTask: await ctx.input.api.get<Issue>(`/api/issues/${(state.negativeCase as CaseRecord).workIssueId}`),
      pendingReview: await ctx.input.api.get<Issue>(`/api/issues/${(state.pendingReview as Entity).id}`), blockerEvidence: await ctx.input.api.get<IssueBlockerDiagnosticsResponse>(`/api/issues/${(state.negativeCase as CaseRecord).workIssueId}/diagnostics/blockers`) } : {}) };
}
function closeObservation(value: unknown): CloseObservation | undefined { const o = value as CloseObservation; return observation(value) && !!o.caseRecord && Array.isArray(o.handoffs) && !!o.finalDocument && Array.isArray(o.finalRevisions) ? o : undefined; }
function closedClaim(reply: string, selected?: string, other?: string) {
  return reply.split(/\n+|;|(?<=[.!?])\s+|\bbut\b/i).some(clause => {
    if (other && clause.includes(other) && (!selected || !clause.includes(selected))) return false;
    return /\bcase(?:\s+[A-Z][A-Z0-9]*-\d+)?\s+(?:(?:is|was|has been|has)\s+)?(?:now\s+)?(?:closed|complete(?:d)?)\b|\b(?:have\s+)?closed\s+(?:the|this|that)\s+case\b/i.test(clause)
      && !/\b(?:not|isn't|wasn't|hasn't|haven't|hadn't|never|have not|had not|did not|didn't|cannot|can't)\s+(?:yet\s+)?(?:close(?:d)?|complete(?:d)?)\b/i.test(clause);
  });
}
export function gradeIntegratorCaseClose(value: unknown) {
  const c = checks(); const o = closeObservation(value); c.add("actual-primary-completion-and-terminal-ledger", !!o, "Requires original ordinary primary, genuine accepted review, terminal handoff and preserved documents."); if (!o) return c.result();
  const original = o.state.case as CaseRecord; const originalTask = o.state.task as Issue; const owner = o.state.worker as Entity;
  const terminal = o.handoffs.find(row => row.destinationKind === "done"); const terminalRun = o.runs.find(run => run.id === terminal?.sourceRunId);
  const primary = o.tasks.find(row => row.id === original.workIssueId);
  c.add("task-done-was-not-case-closure", originalTask.status === "done" && original.status !== "done" && original.completedAt == null,
    "The genuine prerequisite review completed the ordinary task while the case remained open; this alone is not a terminal case receipt.");
  c.add("explicit-terminal-intent-through-real-primary", o.caseRecord.id === original.id && o.caseRecord.workIssueId === original.workIssueId && o.caseRecord.status === "done" && !!o.caseRecord.completedAt && primary?.status === "done"
    && terminal?.state === "completed" && terminal.issueId === primary.id && terminal.actorType === "agent" && terminal.actorId === owner.id && !!terminal.completedAt
    && terminalRun?.agentId === owner.id && terminalRun.runtimeMode === "native" && terminalRun.status === "succeeded" && terminalRun.contextSnapshot?.issueId === primary.id
    && terminalRun.id !== o.state.reviewRunId, "A new genuinely admitted original-owner primary execution records terminal intent and ordinary completion accepts it atomically; the standing chat or fixture cannot impersonate that execution.");
  const review = o.state.review as IssueDocument;
  c.add("accepted-review-and-final-documents-retained", o.finalDocument.id === review.id && o.finalDocument.issueId === original.workIssueId
    && o.finalRevisions.some(revision => revision.id === review.latestRevisionId && revision.body === review.body && revision.createdByAgentId === owner.id && revision.createdByRunId === o.state.reviewRunId)
    && /accept|pass/i.test(review.body) && !/not accepted|not passed|failed/i.test(review.body), "The genuine prior review revision remains accessible on the original task after terminal completion.");
  const first = closeObservation(o.state.initialDirection); const firstReplyTime = o.state.firstReplyTime as string | undefined;
  const result = closeObservation(o.state.acceptedResult);
  const resultText = result && first && result.reply.startsWith(first.reply) ? result.reply.slice(first.reply.length) : "";
  c.add("truthful-actual-close-result", !!first && (!closedClaim(first.reply) || !!terminal?.completedAt && !!firstReplyTime && Date.parse(String(terminal.completedAt)) <= Date.parse(firstReplyTime))
    && !!result && closedClaim(resultText) && result.caseRecord.status === "done", "A pending first acknowledgement is permitted; the explicit actual-result follow-up must report real closure, never task completion alone.");
  const later = result && o.reply.startsWith(result.reply) ? o.reply.slice(result.reply.length) : "";
  c.add("unresolved-required-review-does-not-close", !!o.negativeCase && !!o.negativeTask && !!o.pendingReview && o.negativeCase.workIssueId === o.negativeTask.id
    && o.negativeCase.status !== "done" && !o.negativeCase.completedAt && o.negativeTask.status !== "done" && o.pendingReview.status === "backlog"
    && !!o.blockerEvidence?.blockers.some(blocker => blocker.id === o.pendingReview!.id && blocker.isUnresolved)
    && /review/i.test(later) && /pending|unresolved|not (?:yet )?(?:accepted|complete|closed)|cannot close|can't close|must|waiting/i.test(later) && !closedClaim(later, o.negativeCase?.identifier, original.identifier),
    "The separate explicitly selected case retains its real unresolved review dependency and remains open, with truthful phase-specific denial rather than a fictional terminal result.");
  return c.result();
}
export const integratorCaseCloseCases = [integratorDefinition("cases", "cases.close-case", async ctx => {
  const prior = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental"); settings.set(ctx, prior.enableCases);
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: true }); const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
    await grantCaseTaskAssignment(ctx, worker.id);
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }]) await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const kickoff = await ctx.input.api.post<HandoffCaseResult>(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, {
      idempotencyKey: `close-review-${ctx.input.nonce}`, case: { create: { caseType: "customer", title: "Accepted checkout fix", projectId: p.id, fields: { reviewRequirement: "Verify supplied correction and retain review document" } } }, toAgentId: worker.id, phase: "review",
      instructions: "Review the supplied synthetic checkout correction against its acceptance criteria. Save a task-owned document with key review, the actual reasoning, and accepted or rejected disposition. If the criteria are met, mark this ordinary review task done. Do not perform a terminal case handoff: the person has not requested case closure.",
      workflow_document_text: "Morgan owns this same ordinary primary throughout review and final closure. Its saved review and final documents remain task-owned. Finishing review alone leaves the case open. Only a later explicit accepted-fix closure direction permits Morgan's genuine primary execution to record a terminal handoff and complete normally under ordinary gates.",
      initialDocuments: [{ key: "brief", title: "Synthetic correction acceptance", body: "Controlled checkout patch: before, the Pay control had disabled=true and could not submit. The reviewed correction has disabled=false, one click handler that calls submit once, and the visible accessible name Pay. Accept if activation is permitted, submit occurs exactly once, and the visible name is preserved. No unrelated production payment operation is requested." }],
    });
    const prepared = await pollUntil({ label: "genuine completed review without terminal case closure", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${kickoff.taskId}`), runs: await ctx.allRuns(), documents: await ctx.input.api.get<IssueDocument[]>(`/api/issues/${kickoff.taskId}/documents`) }),
      accept: v => v.task.status === "done" && v.runs.length === 1 && v.runs[0]?.status === "succeeded" && v.documents.some(doc => doc.key === "review") });
    return { project: p, worker: { id: worker.id }, task: prepared.task, case: await ctx.input.api.get<CaseRecord>(`/api/cases/${kickoff.caseId}`), reviewRunId: prepared.runs[0]!.id,
      review: await ctx.input.api.get<IssueDocument>(`/api/issues/${kickoff.taskId}/documents/review`) };
  } catch (error) { await cleanup(ctx); throw error; }
}, observeClose, gradeIntegratorCaseClose, async (ctx, state) => {
  const row = state.case as CaseRecord; const primary = state.task as Issue; await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/cases/${row.identifier}`, row.title);
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${primary.identifier}`, primary.title);
}, { expectedRunCount: 7, minimumRunCount: 6, expectedHumanMessageCount: 3, attemptTimeoutMs: 1_500_000, cleanup,
  sourceFiles: ["chat-catalog-domains/integrator-case-close.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/cases.yaml"],
  async act(ctx, state) {
    const first = await pollUntil({ label: "initial explicit closure direction", deadlineAt: Date.now() + 180_000, intervalMs: 1000, load: () => observeClose(ctx, state),
      accept: o => ctx.issue()?.conversationState === "waiting" && o.runs.some(run => run.agentId === o.leadId && run.contextSnapshot?.issueId === ctx.issue()?.id && run.status === "succeeded") });
    state.initialDirection = { ...first, state: structuredClone(state) };
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`); state.firstReplyTime = comments.filter(comment => comment.authorAgentId === ctx.input.fixtures.agent.id).at(-1)?.createdAt;
    await ctx.input.evidence("chat-case-terminal-direction.json", state.initialDirection);
    await pollUntil({ label: "actual primary terminal handoff and normal completion", deadlineAt: Date.now() + 240_000, intervalMs: 1000, load: () => observeClose(ctx, state),
      accept: o => o.caseRecord.status === "done" && o.handoffs.some(handoff => handoff.destinationKind === "done" && handoff.state === "completed") && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded") });
    const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, `What is the actual saved closure result for case ${(state.case as CaseRecord).identifier}?`);
    const result = await pollUntil({ label: "actual terminal result reported in chat", deadlineAt: Date.now() + 180_000, intervalMs: 1000, load: () => observeClose(ctx, state), accept: o => o.runs.length === 4 && o.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
    state.acceptedResult = { ...result, state: structuredClone(state) }; await ctx.input.evidence("chat-case-terminal-result.json", state.acceptedResult);
    const pendingReview = await task(ctx, "Required independent review remains unresolved", (state.project as Entity).id); state.pendingReview = pendingReview;
    const second = await ctx.input.api.post<HandoffCaseResult>(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, { idempotencyKey: `unreviewed-${ctx.input.nonce}`, case: { create: { caseType: "customer", title: "Unreviewed separate correction", projectId: (state.project as Entity).id } },
      toAgentId: (state.worker as Entity).id, phase: "review", instructions: `The required independent review task ${pendingReview.id} is unresolved. Save it as a real blockedByIssueIds dependency on this ordinary primary, record the missing approval in a task comment, and mark this task blocked. Do not close or terminally hand off the case, resolve its reviewer task, or fabricate acceptance.`,
      workflow_document_text: `This separate correction requires completed independent review task ${pendingReview.id} before ordinary primary completion or case closure. A person's request to skip an unresolved review does not satisfy the required review.` });
    state.negativeCase = await ctx.input.api.get<CaseRecord>(`/api/cases/${second.caseId}`);
    await pollUntil({ label: "real unresolved review completion gate", deadlineAt: Date.now() + 180_000, intervalMs: 1000, load: () => observeClose(ctx, state),
      accept: o => o.runs.length === 5 && o.runs.every(run => run.status === "succeeded") && o.negativeTask?.status === "blocked" && !!o.blockerEvidence?.blockers.some(blocker => blocker.id === pendingReview.id && blocker.isUnresolved) });
    await sendChatMessage(ctx.input.page, `Close the separate case ${(state.negativeCase as CaseRecord).identifier} too, even though its required independent review is still unresolved.`);
  },
})];
