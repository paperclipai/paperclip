import { waitCaseCancellationAccounting } from "./integrator-case-prerequisites.js";
import { randomUUID } from "node:crypto";
import type { cases } from "../../../packages/db/src/schema/cases.js";
import type { HandoffCaseResult } from "../../../packages/shared/src/case-handoffs.js";
import type { Issue } from "../../../packages/shared/src/types/issue.js";
import type { IssueDocument, DocumentRevision } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
interface FactsObservation extends InternalObservation { caseRecord: CaseRecord; brief: IssueDocument; briefRevisions: DocumentRevision[] }
const settings = new WeakMap<ChatCatalogContext, { experimental: boolean; gate?: Awaited<ReturnType<typeof startRunBriefGate>> }>();
async function cleanup(ctx: ChatCatalogContext) { const prior = settings.get(ctx); if (prior === undefined) return; try { await prior.gate?.close(); } finally { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: prior.experimental }); settings.delete(ctx); } }
async function observeFacts(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<FactsObservation> {
  const base = await observeInternal(ctx, state); const row = state.case as CaseRecord;
  return { ...base, caseRecord: await ctx.input.api.get<CaseRecord>(`/api/cases/${row.id}`), brief: await ctx.input.api.get<IssueDocument>(`/api/issues/${row.workIssueId}/documents/brief`), briefRevisions: await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${row.workIssueId}/documents/brief/revisions`) };
}
function factsObservation(value: unknown): FactsObservation | undefined { const o = value as FactsObservation; return observation(value) && !!o.caseRecord && !!o.brief && Array.isArray(o.briefRevisions) ? o : undefined; }
function corrected(fields: unknown) {
  const text = JSON.stringify(fields); const record = fields && typeof fields === "object" ? fields as Record<string, unknown> : {};
  const singleBrowser = [record.browser, record.affectedBrowser].some(value => typeof value === "string" && /^mobile Safari$/i.test(value.trim()))
    || Array.isArray(record.affectedBrowsers) && record.affectedBrowsers.length === 1 && /^mobile Safari$/i.test(String(record.affectedBrowsers[0]));
  return /mobile Safari/i.test(text) && (singleBrowser || /\bonly\b|\bexclusive/i.test(text)) && !/not (?:only |exclusive[^ ]* )?mobile Safari|desktop Safari only/i.test(text);
}
function retained(o: FactsObservation, concurrent: boolean) {
  const original = o.state.case as CaseRecord; const fields = o.caseRecord.fields as Record<string, unknown>;
  const before = original.fields as Record<string, unknown>;
  return o.caseRecord.id === original.id && o.caseRecord.workIssueId === original.workIssueId && corrected(fields)
    && fields.customer === before.customer && fields.severity === before.severity && fields.expected === before.expected
    && (!concurrent || fields.supportEscalation === o.state.collaboratorValue);
}
export function gradeIntegratorCaseFacts(value: unknown) {
  const c = checks(); const o = factsObservation(value); c.add("saved-case-and-task-document-evidence", !!o, "Requires real case facts, ordinary-task document revisions, phase checkpoints and native handoff context."); if (!o) return c.result();
  c.add("genuine-paused-active-primary-prerequisite", o.runs.some(run => run.id === o.state.initialRunId && run.agentId === (o.state.worker as Entity).id && run.contextSnapshot?.issueId === (o.state.case as CaseRecord).workIssueId && run.status === "cancelled" && run.runtimeMode === "native"), "The initial ordinary active task is released by an actual operator stop, allowing a later normal board handoff without silently overriding a blocked-task gate.");
  const first = factsObservation(o.state.firstCorrection); const fresh = factsObservation(o.state.collaborationCheckpoint);
  c.add("initial-correction-preserves-unrelated-fields", !!first && retained(first, false), "The unchanged first query must already correct the saved facts without discarding unrelated fields; a later turn cannot repair an initially wrong mutation.");
  c.add("fresh-collaborative-change-not-stale-replacement", !!fresh && retained(fresh, true) && retained(o, true)
    && fresh.reply.split(/\n+|(?<=[.!?])\s+/).some(sentence => /mobile Safari/i.test(sentence) && /only|exclusiv/i.test(sentence) && !/not (?:only |exclusive[^ ]* )?mobile Safari/i.test(sentence))
    && fresh.reply.includes(String(o.state.collaboratorValue)), "A real independently saved support change survives the explicit reread, and chat reports both the correction and that actual concurrent field.");
  const before = o.state.brief as IssueDocument; const original = o.state.case as CaseRecord;
  c.add("ordinary-task-document-ownership-and-history", o.brief.id === before.id && o.brief.issueId === original.workIssueId
    && o.briefRevisions.some(revision => revision.id === before.latestRevisionId && revision.issueId === original.workIssueId && revision.body === before.body), "The original ordinary-task document and its actual saved revision remain owned and accessible on the same primary task.");
  const reviewerId = (o.state.reviewer as Entity).id;
  const run = o.runs.find(row => row.agentId === reviewerId && row.contextSnapshot?.issueId === original.workIssueId);
  const context = run?.contextSnapshot?.paperclipCase as { id?: string; taskId?: string; data?: string } | undefined;
  let projected: { fields?: unknown } | undefined; try { projected = JSON.parse(context?.data ?? "null") ?? undefined; } catch { /* malformed public projection fails below */ }
  const projectedFields = projected?.fields as Record<string, unknown> | undefined;
  c.add("subsequent-real-handoff-carries-current-facts", !!run && run.status === "succeeded" && run.runtimeMode === "native" && context?.id === original.id && context.taskId === original.workIssueId
    && corrected(projectedFields) && projectedFields?.supportEscalation === o.state.collaboratorValue
    && projectedFields?.customer === (original.fields as Record<string, unknown>).customer && o.caseRecord.handoffVersion === original.handoffVersion + 1,
    "A subsequent genuinely admitted reviewer on the same primary receives the saved correction plus collaboration change in its actual case context, not a fixture-synthesized context.");
  return c.result();
}
export const integratorCaseFactsCases = [integratorDefinition("cases", "cases.update-case-facts", async ctx => {
  const prior = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental"); settings.set(ctx, { experimental: prior.enableCases });
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: true }); const p = await project(ctx, "Launch");
    const worker = await fixtureWorker(ctx); const reviewer = await fixtureWorker(ctx); await ctx.input.api.patch(`/api/agents/${reviewer.id}`, { name: "Riley" });
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[worker.id, reviewer.id].map(scopeId => ({ scopeType: "agent", scopeId }))])
      await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const gate = await startRunBriefGate(ctx, worker.id); settings.get(ctx)!.gate = gate;
    const kickoff = await ctx.input.api.post<HandoffCaseResult>(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, {
      idempotencyKey: `facts-${ctx.input.nonce}`, case: { create: { caseType: "customer", title: "Checkout reproduction case", projectId: p.id,
        fields: { browser: "Safari; affected device not yet confirmed", customer: "Acorn Test Shop", severity: "normal", expected: "Pay should submit a single order" } } }, toAgentId: worker.id, phase: "investigation",
      instructions: "Read the saved customer brief. The affected device is not yet confirmed: record the missing reproduction detail in a task comment, then call the connected Website Brief read_website_brief tool to wait for the remaining customer evidence. Keep this ordinary investigation active; do not complete it, invent the affected device, or alter case facts.",
      workflow_document_text: "Morgan investigates this ordinary primary. A corrected customer reproduction detail must remain in saved case facts alongside unrelated customer fields. Riley reviews the current saved case when a later actual review handoff is requested, records a task comment, and completes the review task without closing the case.",
      initialDocuments: [{ key: "brief", title: "Customer reproduction brief", body: "Acorn Test Shop: Safari checkout Pay sometimes does not submit. The affected device has not yet been confirmed. Expected result is one submitted order." }],
    });
    const initial = await pollUntil({ label: "actual active case waiting for missing reproduction evidence", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${kickoff.taskId}`), runs: await ctx.allRuns() }), accept: v => v.runs.length === 1 && v.runs[0]?.status === "running" && v.task.status === "in_progress" && gate.calls.some(call => call.authorized) });
    await ctx.input.api.post(`/api/heartbeat-runs/${initial.runs[0]!.id}/cancel`, { cancellationRequestId: randomUUID() });
    await pollUntil({ label: "actual operator stop releases primary without changing task status", deadlineAt: Date.now() + 90_000, intervalMs: 1000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${kickoff.taskId}`), runs: await ctx.allRuns() }),
      accept: v => v.runs.length === 1 && v.runs[0]?.status === "cancelled" && v.task.status === "in_progress" && !v.task.executionRunId && !v.task.checkoutRunId });
    gate.release();
    await waitCaseCancellationAccounting(ctx, { companyId: ctx.input.fixtures.company.id, agentId: worker.id, issueId: kickoff.taskId, runId: initial.runs[0]!.id });
    return { initialRunId: initial.runs[0]!.id, project: p, worker: { id: worker.id }, reviewer: { id: reviewer.id }, case: await ctx.input.api.get<CaseRecord>(`/api/cases/${kickoff.caseId}`),
      brief: await ctx.input.api.get<IssueDocument>(`/api/issues/${kickoff.taskId}/documents/brief`), collaboratorValue: `support-${ctx.input.nonce}` };
  } catch (error) { await cleanup(ctx); throw error; }
}, observeFacts, gradeIntegratorCaseFacts, async (ctx, state) => {
  const row = state.case as CaseRecord; await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/cases/${row.identifier}`, row.title);
  const task = await ctx.input.api.get<Issue>(`/api/issues/${row.workIssueId}`);
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier}`, task.title);
}, { expectedRunCount: 4, expectedHumanMessageCount: 2, attemptTimeoutMs: 900_000, runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 3 } },
  sourceFiles: ["chat-catalog-domains/integrator-case-facts.ts", "chat-catalog-domains/internal-run-brief.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/cases.yaml"], cleanup,
  async act(ctx, state) {
    const settle = (count: number) => pollUntil({ label: `saved case correction phase ${count}`, deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: () => observeFacts(ctx, state), accept: o => o.runs.length === count && o.runs.every(run => run.status === (run.id === state.initialRunId ? "cancelled" : "succeeded")) && ctx.issue()?.conversationState === "waiting" });
    const first = await settle(2); state.firstCorrection = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-case-initial-correction.json", state.firstCorrection);
    if (!retained(first, false)) throw new Error("Initial case correction was incorrect; a follow-up cannot repair this phase");
    const row = first.caseRecord;
    await ctx.input.api.patch(`/api/cases/${row.id}`, { fields: { ...(row.fields as Record<string, unknown>), supportEscalation: state.collaboratorValue } });
    const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, "Support updated this case while we were talking. Read its current saved facts: does it still include my corrected reproduction step, and what support escalation is saved now?");
    const fresh = await settle(3); state.collaborationCheckpoint = { ...fresh, state: structuredClone(state) }; await ctx.input.evidence("chat-case-concurrent-change.json", state.collaborationCheckpoint);
    if (!retained(fresh, true)) throw new Error("Chat overwrote or lost the separately saved collaboration change");
    const task = await ctx.input.api.get<Issue>(`/api/issues/${row.workIssueId}`);
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, { case: { id: row.id }, expectedHandoffVersion: fresh.caseRecord.handoffVersion,
      expectedIssueStatusVersion: task.statusVersion, idempotencyKey: `facts-review-${ctx.input.nonce}`, toAgentId: (state.reviewer as Entity).id, phase: "review",
      instructions: "Review the current saved case facts and task-owned brief, record your assessment in a task comment, and complete this ordinary review task. Keep the case open; no terminal handoff is requested." });
  },
})];
