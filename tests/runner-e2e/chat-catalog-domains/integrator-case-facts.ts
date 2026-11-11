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
import { commentWokenContinuations, runIssueId, type RoleComment } from "./run-roles.js";
type CaseRecord = typeof cases.$inferSelect;
interface FactsObservation extends InternalObservation { caseRecord: CaseRecord; brief: IssueDocument; briefRevisions: DocumentRevision[]; workComments: RoleComment[] }
const settings = new WeakMap<ChatCatalogContext, { experimental: boolean; gate?: Awaited<ReturnType<typeof startRunBriefGate>> }>();
async function cleanup(ctx: ChatCatalogContext) { const prior = settings.get(ctx); if (prior === undefined) return; try { await prior.gate?.close(); } finally { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: prior.experimental }); settings.delete(ctx); } }
async function observeFacts(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<FactsObservation> {
  const base = await observeInternal(ctx, state); const row = state.case as CaseRecord;
  return { ...base, caseRecord: await ctx.input.api.get<CaseRecord>(`/api/cases/${row.id}`), brief: await ctx.input.api.get<IssueDocument>(`/api/issues/${row.workIssueId}/documents/brief`), briefRevisions: await ctx.input.api.get<DocumentRevision[]>(`/api/issues/${row.workIssueId}/documents/brief/revisions`),
    workComments: await ctx.input.api.get<RoleComment[]>(`/api/issues/${row.workIssueId}/comments?order=asc`) };
}
function factsObservation(value: unknown): FactsObservation | undefined { const o = value as FactsObservation; return observation(value) && !!o.caseRecord && !!o.brief && Array.isArray(o.briefRevisions) && Array.isArray(o.workComments) ? o : undefined; }
/** Every run by role: the stopped setup run, the CEO's chat turns, at most one Morgan continuation per CEO turn
 * woken by that turn's comment on the case task (telling the owner about the corrected fact), and at most one
 * Riley review run on the case task. Anything else is extra work. */
export function caseFactsRoles(o: Pick<FactsObservation, "runs" | "workComments" | "leadId" | "state"> & { sourceId?: string }) {
  const original = o.state.case as CaseRecord, workerId = (o.state.worker as Entity).id, reviewerId = (o.state.reviewer as Entity).id;
  const ceo = o.runs.filter(run => run.agentId === o.leadId && !!o.sourceId && runIssueId(run) === o.sourceId);
  const continuation = commentWokenContinuations(o.runs, { agentId: workerId, issueId: original.workIssueId ?? "", comments: o.workComments, causeRunIds: ceo.map(run => run.id) });
  const review = o.runs.filter(run => run.agentId === reviewerId && runIssueId(run) === original.workIssueId);
  const initial = o.runs.filter(run => run.id === o.state.initialRunId);
  const unexplained = o.runs.filter(run => !initial.includes(run) && !ceo.includes(run) && !continuation?.includes(run) && !review.includes(run));
  return { ceo, continuation: continuation ?? [], review, valid: !!continuation && initial.length === 1 && review.length <= 1 && unexplained.length === 0 };
}
/** The setup records the reproduction browser in `browser`; the person's correction is "only on mobile Safari".
 * A corrected value is graded by its normalized tokens: Safari plus a mobile-platform qualifier and nothing
 * else (filler such as "only"/"on" is ignored). "iOS Safari" and "Safari on iPhone/iPad" are the same fact;
 * any other token (desktop, "not", "and", a second browser, the stale "not yet confirmed") is a different one. */
const FILLER = new Set(["only", "on", "exclusively", "just", "the", "browser", "browsers", "device", "devices", "affected"]);
const MOBILE = new Set(["mobile", "ios", "iphone", "ipad", "ipados"]);
const tokens = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token && !FILLER.has(token));
/** A value may add clauses that only rule other platforms out ("desktop Safari unaffected",
 * "not on Chrome"): such a clause carries a negation and names a non-mobile platform or browser and
 * no mobile one. Every other clause together must still say exactly mobile Safari. */
const EXCLUDES = /\b(?:unaffected|excluded|not (?:affected|impacted|reproducible)|(?:does not|doesn't|never) (?:occur|happen|reproduce)|works(?: fine)?|is fine)\b|^\s*(?:not|never|no)\b/i;
const OTHER_PLATFORM = new Set(["desktop", "mac", "macos", "windows", "linux", "android", "chrome", "firefox", "edge", "laptop"]);
function mobileSafariOnly(value: unknown) {
  if (typeof value !== "string") return false;
  const clauses = value.split(/[;,()]|\s[-\u2013\u2014]\s|\bbut\b/i).filter(clause => tokens(clause).length > 0);
  const exclusion = (clause: string) => { const t = tokens(clause);
    return EXCLUDES.test(clause) && !/\bnot\s+(?:excluded|unaffected)\b/i.test(clause) && t.some(token => OTHER_PLATFORM.has(token)) && !t.some(token => MOBILE.has(token)); };
  const t = clauses.filter(clause => !exclusion(clause)).flatMap(tokens);
  return t.includes("safari") && t.some(token => MOBILE.has(token)) && t.every(token => token === "safari" || MOBILE.has(token));
}
function mobilePlatformOnly(value: unknown) { if (typeof value !== "string") return false; const t = tokens(value); return t.length > 0 && t.every(token => MOBILE.has(token)); }
export function corrected(fields: unknown) {
  const record = fields && typeof fields === "object" ? fields as Record<string, unknown> : {};
  const platformSplit = Object.entries(record).some(([key, value]) => /^(?:platform|os|device)$/i.test(key) && mobilePlatformOnly(value));
  const browserValues = [record.browser, record.affectedBrowser].filter(value => value !== undefined);
  if (record.affectedBrowsers !== undefined) browserValues.push(Array.isArray(record.affectedBrowsers) && record.affectedBrowsers.length === 1 ? record.affectedBrowsers[0] : null);
  return browserValues.length > 0 && browserValues.every(value => mobileSafariOnly(value)
    || platformSplit && typeof value === "string" && tokens(value).join(" ") === "safari");
}
/** The follow-up reply is the text added after the first checkpoint. It must name the case (its identifier or its
 * primary task) and the setup-chosen support escalation literal. Whether its wording is right is free-form text that a
 * person reads; the saved fields above are the proof of the outcome. */
export function latestReply(fresh: InternalObservation, first: InternalObservation | undefined) {
  return first && fresh.reply.startsWith(first.reply) ? fresh.reply.slice(first.reply.length) : fresh.reply;
}
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function reportsCurrentFacts(reply: string, o: FactsObservation) {
  const caseRow = o.state.case as CaseRecord & { identifier?: string }; const task = o.tasks.find(row => row.id === caseRow.workIssueId);
  const names = [caseRow.identifier, task?.identifier, caseRow.id, caseRow.workIssueId].filter((value): value is string => !!value);
  const refersToCase = names.some(name => new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, "i").test(reply));
  return refersToCase && reply.includes(String(o.state.collaboratorValue));
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
    && reportsCurrentFacts(latestReply(fresh, first), o), "A real independently saved support change survives the explicit reread; the follow-up reply names the case and the actual concurrent field.");
  const before = o.state.brief as IssueDocument; const original = o.state.case as CaseRecord;
  c.add("ordinary-task-document-ownership-and-history", o.brief.id === before.id && o.brief.issueId === original.workIssueId
    && o.briefRevisions.some(revision => revision.id === before.latestRevisionId && revision.issueId === original.workIssueId && revision.body === before.body), "The original ordinary-task document and its actual saved revision remain owned and accessible on the same primary task.");
  const reviewerId = (o.state.reviewer as Entity).id;
  const run = o.runs.find(row => row.agentId === reviewerId && row.contextSnapshot?.issueId === original.workIssueId);
  const context = run?.contextSnapshot?.paperclipCase as { id?: string; taskId?: string; data?: string } | undefined;
  let projected: { fields?: unknown } | undefined; try { projected = JSON.parse(context?.data ?? "null") ?? undefined; } catch { /* malformed public projection fails below */ }
  const projectedFields = projected?.fields as Record<string, unknown> | undefined;
  const roles = caseFactsRoles({ ...o, sourceId: o.state.sourceId as string | undefined });
  c.add("role-bound-runs", roles.valid && roles.ceo.length === 2 && roles.review.length === 1,
    "Two CEO chat turns, the stopped setup run and one Riley review run; Morgan may continue only when a CEO turn's comment on the case task wakes Morgan, once per turn. No other run is admitted.");
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
}, { oracleVersion: "paperclip.chat-catalog.integrator.case-facts.v6", expectedRunCount: 6, minimumRunCount: 4, expectedHumanMessageCount: 2, attemptTimeoutMs: 900_000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 3 }, maximumTerminalStatusCounts: { succeeded: 5 } },
  sourceFiles: ["chat-catalog-domains/integrator-case-facts.ts", "chat-catalog-domains/run-roles.ts", "chat-catalog-domains/internal-run-brief.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/cases.yaml"], cleanup,
  async act(ctx, state) {
    // A phase settles when its CEO turn and any Morgan continuation that turn's task comment woke have finished.
    // The standing chat may only exist once the query is sent (gha-42939717023: an unknown source made the CEO's
    // own turn look undeclared), so bind the source from the refreshed conversation and judge roles only once it is known.
    const settle = (turns: number) => pollUntil({ label: `saved case correction phase ${turns}`, deadlineAt: Date.now() + 300_000, intervalMs: 1000,
      load: async () => { const o = await observeFacts(ctx, state); state.sourceId ??= ctx.issue()?.id; return o; },
      accept: o => { const roles = caseFactsRoles({ ...o, sourceId: state.sourceId as string }); return !!state.sourceId && roles.valid && roles.ceo.length === turns && roles.review.length === 0
        && o.runs.every(run => run.status === (run.id === state.initialRunId ? "cancelled" : "succeeded")) && ctx.issue()?.conversationState === "waiting"; },
      reject: o => { const roles = caseFactsRoles({ ...o, sourceId: state.sourceId as string });
        return !!state.sourceId && !roles.valid || roles.ceo.length > turns || roles.review.length > 0 || o.runs.some(run => run.id !== state.initialRunId && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Case correction admitted failed, duplicate or undeclared work" : undefined; } });
    const first = await settle(1); state.firstCorrection = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-case-initial-correction.json", state.firstCorrection);
    if (!retained(first, false)) throw new Error("Initial case correction was incorrect; a follow-up cannot repair this phase");
    const row = first.caseRecord;
    await ctx.input.api.patch(`/api/cases/${row.id}`, { fields: { ...(row.fields as Record<string, unknown>), supportEscalation: state.collaboratorValue } });
    const { sendChatMessage } = await import("../chat-flow.js");
    await sendChatMessage(ctx.input.page, "Support updated this case while we were talking. Read its current saved facts: does it still include my corrected reproduction step, and what support escalation is saved now?");
    const fresh = await settle(2); state.collaborationCheckpoint = { ...fresh, state: structuredClone(state) }; await ctx.input.evidence("chat-case-concurrent-change.json", state.collaborationCheckpoint);
    if (!retained(fresh, true)) throw new Error("Chat overwrote or lost the separately saved collaboration change");
    const task = await ctx.input.api.get<Issue>(`/api/issues/${row.workIssueId}`);
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/case-handoffs`, { case: { id: row.id }, expectedHandoffVersion: fresh.caseRecord.handoffVersion,
      expectedIssueStatusVersion: task.statusVersion, idempotencyKey: `facts-review-${ctx.input.nonce}`, toAgentId: (state.reviewer as Entity).id, phase: "review",
      instructions: "Review the current saved case facts and task-owned brief, record your assessment in a task comment, and complete this ordinary review task. Keep the case open; no terminal handoff is requested." });
  },
})];
