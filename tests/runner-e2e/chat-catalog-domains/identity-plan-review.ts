import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";
import type { IssueDocument, IssueDocumentSummary, DocumentRevision } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { checks, entity, hasLink, putDocument, verifyInternalResult, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, openStandingChat, type Interaction, type IdentityObservation } from "./identity-support.js";

interface PlanInteraction extends Interaction { payload: Interaction["payload"] & { target?: { revisionId?: string } } }
function gradePlanReviewOutcome(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-versioned-workflow", !!o, "Actual versioned decisions, attributed ordinary work and browser receipts are required."); if (!o) return c.result();
  const original = o.state.original as PlanInteraction | undefined; const current = o.interactions.find(row => row.id === original?.id) as PlanInteraction | undefined;
  const plan = o.state.plan as Entity | undefined; const saved = o.tasks[0]; const worker = o.state.worker as Entity | undefined;
  c.add("same-request-version", !!original && !!current && typeof plan?.latestRevisionId === "string" && JSON.stringify(current.payload) === JSON.stringify(original.payload)
    && original.payload.target?.revisionId === plan?.latestRevisionId,
    "The actual current request retains the reviewed source document revision without authorizing another version.");
  if (o.scenarioId === "questions-and-approvals.review-plan") {
    c.add("ordinary-linked-execution", o.tasks.length === 1 && saved?.companyId === o.companyId && saved.id !== o.state.sourceId && saved.parentId == null
    && saved.assigneeAgentId === worker?.id && hasLink(o, "issues", saved) && o.activity.some(row => row.action === "issue.created" && row.entityId === saved.id && row.agentId === o.leadId)
    && o.state.sourceRetainsConversation === true && o.runs.some(run => run.agentId === worker?.id && (run.contextSnapshot?.issueId === saved.id || (run as unknown as { nativeIssueId?: string }).nativeIssueId === saved.id)),
    "The agent creates one linked ordinary task assigned to the real Morgan, whose actual admitted execution is bound to that task; chat remains a conversation.");
    c.add("canonical-human-approval-bound", current?.status === "accepted" && current.resolvedByAgentId === o.leadId
      && o.state.sourcePlanRevisionAfter === plan?.latestRevisionId && typeof o.state.canonicalCommentId === "string" && current.result?.commentId === o.state.canonicalCommentId
      && o.activity.some(row => row.action === "issue.thread_interaction_accepted" && row.details?.interactionId === original?.id && row.details?.responseCommentId === o.state.canonicalCommentId),
      "The exact canonical conversational approval is attached to the real reviewed revision and decision audit.");
    const scopeInBrief = !!saved && `${saved.title} ${saved.description}`.includes(String(o.state.scopeMarker));
    const scopeInSavedPlan = !!saved && o.documents.some(doc => doc.issueId === saved.id && doc.key === "plan"
      && (doc.body ?? "").includes(String(o.state.scopeMarker)) && typeof plan?.latestRevisionId === "string"
      && (doc.body ?? "").includes(plan.latestRevisionId) && typeof doc.latestRevisionId === "string"
      && o.revisions.some(revision => revision.id === doc.latestRevisionId && revision.documentId === doc.id
        && o.runs.some(run => run.id === revision.createdByRunId && run.agentId === revision.createdByAgentId
          && (run.agentId === o.leadId || run.agentId === worker?.id
            && (run.contextSnapshot?.issueId === saved.id || (run as unknown as { nativeIssueId?: string }).nativeIssueId === saved.id)))));
    c.add("reviewed-scope-handed-off", scopeInBrief || scopeInSavedPlan, "The actual ordinary task retains the approved scope in its brief or an attributed saved plan bound to the reviewed source revision.");
    c.add("stale-review-shows-new-version", o.state.staleAttemptStatus === 409 && o.state.staleErrorCode === "interaction_stale_target" && o.state.newerRevisionVisible === true
      && o.state.newerRevisionId !== o.state.staleRevisionId && o.state.staleExpired === true,
      "A separately opened real old revision becomes unapprovable after a public edit; the browser shows the actual newer version instead of approving unseen work.");
  } else if (o.scenarioId === "questions-and-approvals.reject-and-revise") {
    c.add("publication-decision-declined", ["rejected", "superseded"].includes(current?.status ?? "") && !o.activity.some(row => row.action === "issue.thread_interaction_accepted" && row.details?.interactionId === original?.id)
      && o.state.rejectedReceiptVisible === true, "The old publication request remains visibly declined or superseded and is never accepted.");
    c.add("real-local-review-draft", o.documents.length > 0 && o.documents.some(row => (row.body ?? "").includes(String(o.state.scopeMarker)) && /draft|review/i.test(row.body ?? "")
      && !!row.latestRevisionId && row.latestRevisionId !== plan?.latestRevisionId && o.revisions.some(revision => revision.id === row.latestRevisionId && revision.documentId === row.id
        && o.runs.some(run => run.id === revision.createdByRunId && run.agentId === revision.createdByAgentId && [o.leadId, worker?.id].includes(run.agentId)))
      && (row.issueId === o.state.sourceId ? o.links.some(link => link.includes(`#document-${encodeURIComponent(row.key!)}`)) : o.tasks.some(task => task.id === row.issueId && hasLink(o, "issues", task))))
      && o.state.sourceRetainsConversation === true && o.state.noPublishedWorkProduct === true && !/\b(?:I|we)(?:'ve| have)?\s+(?:published|deployed)\b/i.test(o.reply),
      "The revised scope produces an actual attributed local review document and linked task, without a published delivery record or claimed publication.");
  } else c.add("known-plan-workflow", false, "No oracle exists for this workflow.");
  return c.result();
}

interface PlanComment { id: string; authorAgentId?: string | null; authorUserId?: string | null; createdByRunId?: string | null; createdAt?: string; bodyPresent: boolean; matchesQuery: boolean }
const stamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
/** Counts every actual turn. A second CEO turn is permitted only as the server's
 * distinct, settled completion delivery for this source's exact delegated work. */
export function planDecisionSourceComplete(value: unknown) {
  const o = identityObservation(value); if (!o || typeof o.state.sourceId !== "string" || !o.state.sourceId || !Array.isArray(o.state.planDecisionComments) || !o.runs.length || o.runs.length > 3 || new Set(o.runs.map(run => run.id)).size !== o.runs.length) return false;
  const comments = o.state.planDecisionComments as PlanComment[], humans = comments.filter(row => !row.authorAgentId);
  if (humans.length !== 1 || typeof o.state.personId !== "string" || humans[0]!.authorUserId !== o.state.personId || humans[0]!.id !== o.state.canonicalCommentId || !humans[0]!.matchesQuery) return false;
  if (o.runs.some(run => run.companyId !== o.companyId || run.runtimeMode !== "native" || !["queued", "running", "succeeded"].includes(run.status))) return false;
  const ceos = o.runs.filter(run => run.agentId === o.leadId && run.contextSnapshot?.issueId === o.state.sourceId);
  const initial = ceos.filter(run => run.contextSnapshot?.commentId === humans[0]!.id);
  if (initial.length !== 1 || initial[0]!.status !== "succeeded" || !(stamp(humans[0]!.createdAt) <= stamp(initial[0]!.startedAt))) return false;
  const worker = o.state.worker as Entity | undefined;
  const others = o.runs.filter(run => !ceos.includes(run));
  if (others.length > 1 || others.some(run => run.agentId !== worker?.id || !o.tasks.some(task => task.id === run.contextSnapshot?.issueId && task.companyId === o.companyId && task.assigneeAgentId === worker?.id))) return false;
  if (ceos.length === 1) return o.runs.length === ceos.length + others.length;
  if (ceos.length !== 2 || others.length !== 1 || others[0]!.status !== "succeeded") return false;
  const completion = ceos.find(run => run.id !== initial[0]!.id)!;
  const task = o.tasks.find(task => task.id === others[0]!.contextSnapshot?.issueId);
  if (!task || task.status !== "done" || completion.status !== "succeeded" || completion.contextSnapshot?.wakeReason !== "chat_task_completed" || completion.contextSnapshot?.wakeSource !== "automation") return false;
  const ids = completion.contextSnapshot.chatCompletionDeliveryIds, updates = completion.contextSnapshot.chatCompletionUpdates;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0] || ids[0].length > 240 || !Array.isArray(updates) || updates.length !== 1 || updates[0]?.id !== task.id || updates[0]?.status !== "done") return false;
  const completedAt = stamp(updates[0]?.completedAt), initialAt = stamp(initial[0]!.startedAt), workerAt = stamp(others[0]!.startedAt), continuationAt = stamp(completion.startedAt);
  if (![completedAt, initialAt, workerAt, continuationAt].every(Number.isFinite) || initialAt > workerAt || workerAt > completedAt || completedAt > continuationAt) return false;
  const savedResponse = comments.filter(row => row.authorAgentId === o.leadId && row.createdByRunId === completion.id && row.bodyPresent && stamp(row.createdAt) >= continuationAt);
  const savedOutput = o.documents.some(doc => doc.issueId === task.id && !!doc.body?.trim() && !!doc.latestRevisionId
    && o.revisions.some(revision => revision.id === doc.latestRevisionId && revision.documentId === doc.id && revision.createdByRunId === others[0]!.id && revision.createdByAgentId === worker?.id))
    || o.comments.some(comment => comment.companyId === o.companyId && comment.issueId === task.id && comment.authorAgentId === worker?.id && comment.createdByRunId === others[0]!.id && !!comment.body?.trim());
  return savedResponse.length === 1 && savedOutput;
}
export function gradePlanReview(value: unknown) {
  const base = gradePlanReviewOutcome(value), source = planDecisionSourceComplete(value);
  return { passed: base.passed && source, checks: [...base.checks, { id: "original-source-and-optional-completion", passed: source,
    detail: "The original human/source/native decision retains all actual runs; an optional second CEO turn needs a unique real completed-worker/output/source-delivery join." }] };
}
function planDecisionWorkReady(o: IdentityObservation) {
  const grade = gradePlanReviewOutcome(o), review = o.scenarioId.endsWith("review-plan");
  const required = review ? ["same-request-version", "ordinary-linked-execution", "canonical-human-approval-bound", "reviewed-scope-handed-off"] : ["same-request-version", "real-local-review-draft"];
  if (!required.every(id => grade.checks.find(check => check.id === id)?.passed)) return false;
  if (review) return true;
  const current = o.interactions.find(row => row.id === (o.state.original as Entity | undefined)?.id);
  return ["rejected", "superseded"].includes(current?.status ?? "") && !o.activity.some(row => row.action === "issue.thread_interaction_accepted" && row.details?.interactionId === current?.id);
}

async function observePlanReview(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const scenarioId = ctx.scenario.id;
    const o = await observeIdentity(ctx, state); o.tasks = o.tasks.filter(row => row.id !== state.staleTaskId);
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    state.planDecisionComments = comments.map(row => ({ id: row.id, authorAgentId: row.authorAgentId, authorUserId: row.authorUserId,
      createdByRunId: row.createdByRunId, createdAt: row.createdAt, bodyPresent: !!row.body?.trim(), matchesQuery: row.body?.trim() === ctx.scenario.query }));
    state.canonicalCommentId = comments.find(row => row.authorUserId === state.personId && !row.authorAgentId && row.body?.trim() === ctx.scenario.query)?.id;
    state.sourcePlanRevisionAfter = (await ctx.input.api.get<IssueDocument>(`/api/issues/${ctx.issue()!.id}/documents/plan`)).latestRevisionId;
    state.sourceRetainsConversation = ctx.issue()?.assigneeAgentId === ctx.input.fixtures.agent.id && ctx.issue()?.status === "in_review" && ctx.issue()?.conversationState === "waiting";
    o.documents = [];
    o.comments = [];
    let published = false;
    const documentIssueIds = [...o.tasks.map(task => task.id), ...(scenarioId.endsWith("reject-and-revise") ? [ctx.issue()!.id] : [])];
    for (const issueId of documentIssueIds) {
      const docs = await ctx.input.api.get<IssueDocumentSummary[]>(`/api/issues/${issueId}/documents`);
      const full = await Promise.all(docs.map(doc => ctx.input.api.get<IssueDocument>(`/api/issues/${issueId}/documents/${encodeURIComponent(doc.key)}`)));
      if (full.some(doc => doc.companyId !== ctx.input.fixtures.company.id || doc.issueId !== issueId)) throw new Error("Plan document readback escaped the selected source task");
      o.documents.push(...full.map(doc => ({ id: doc.id, issueId: doc.issueId, key: doc.key, body: doc.body, latestRevisionId: doc.latestRevisionId ?? undefined })));
    }
    // Normal task comments are also inspectable saved work; completion does not
    // require an unrequested document format. Raw user-facing output remains in
    // the protected original so existing privacy/evidence checks still apply.
    for (const task of o.tasks) {
      const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/comments?order=asc`);
      if (comments.some(comment => comment.companyId !== ctx.input.fixtures.company.id || comment.issueId !== task.id)) throw new Error("Plan output comment escaped the selected source task");
      o.comments.push(...comments);
    }
    for (const issueId of [ctx.issue()!.id, ...o.tasks.map(task => task.id)]) {
      const products = await ctx.input.api.get<IssueWorkProduct[]>(`/api/issues/${issueId}/work-products`);
      published ||= products.some(product => !["document", "artifact"].includes(product.type) || product.provider !== "paperclip"
        || product.url != null && new URL(product.url, ctx.input.api.baseURL).origin !== ctx.input.api.baseURL);
    }
    const revisions = (await Promise.all(o.documents.map(row => ctx.input.api.get<DocumentRevision[]>(`/api/issues/${row.issueId}/documents/${encodeURIComponent(row.key!)}/revisions`)))).flat();
    o.revisions = revisions.map(row => ({ id: row.id, documentId: row.documentId, createdByRunId: row.createdByRunId, createdByAgentId: row.createdByAgentId }));
    state.noPublishedWorkProduct = !published; return o;
}

const sources = ["chat-catalog-domains/identity-plan-review.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/questions-and-approvals.yaml"];
export const planReviewIdentityCases: readonly ChatCatalogCase[] = ["questions-and-approvals.review-plan", "questions-and-approvals.reject-and-revise"].map(scenarioId => identityDefinition(scenarioId, async ctx => {
  const source = await openStandingChat(ctx); const worker = await identityWorker(ctx); const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (!session.user?.id) throw new Error("Plan review requires its actual responsible human session"); const review = scenarioId.endsWith("review-plan");
  const scopeMarker = `Acorn research launch ${ctx.input.nonce}`;
  const plan = await putDocument(ctx, source.id, `# ${scopeMarker}\n${review ? "Create a local implementation checklist for a research notes website. Begin the assigned checklist work after the current plan revision is approved." : "Proposed action: publish the research notes introduction page. Its subject is a research notebook product for small science teams."}\nUse the exact project context ${scopeMarker}.`);
  const original = await ctx.input.api.post<PlanInteraction>(`/api/issues/${source.id}/interactions`, createIssueThreadInteractionSchema.parse({ kind: "request_confirmation", title: review ? "Approve current research launch plan" : "Publish research launch introduction",
    resolverPolicy: "anyone", continuationPolicy: "none", payload: { version: 1, prompt: review ? "Approve the current plan and start its linked ordinary work?" : "Publish the proposed introduction page?",
      detailsMarkdown: `Review the actual attached plan revision ${plan.latestRevisionNumber}. ${review ? "Approval hands off one ordinary task to Morgan, not the conversation." : "A different requested draft scope must decline this publication proposal and create a local review draft instead. Publication requires a separate explicit accepted decision."}`,
      supersedeOnUserComment: false, target: { type: "issue_document", issueId: source.id, documentId: plan.id, key: "plan", revisionId: plan.latestRevisionId, revisionNumber: plan.latestRevisionNumber } } }));
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); return { sourceId: source.id, personId: session.user.id, worker, plan, original, scopeMarker };
}, gradePlanReview, {
  sourceFiles: [...sources, "../../server/src/services/chat-completion-delivery.ts"], authentication: "human-session", oracleVersion: "paperclip.chat-catalog.plan-review.v2", expectedRunCount: 3, minimumRunCount: scenarioId.endsWith("review-plan") ? 2 : 1, attemptTimeoutMs: 600_000,
  runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
  async act(ctx, state) {
    const originalDeadline = ctx.observationDeadlineAt;
    if (!Number.isFinite(originalDeadline) || originalDeadline! <= Date.now()) throw new Error("Original plan-review observation budget exhausted or missing");
    const deadlineAt = Math.min(chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000), originalDeadline!);
    await pollUntil({ label: "Plan decision source settled", deadlineAt,
      load: async () => ({ observation: await observePlanReview(ctx, state), source: ctx.issue() }),
      accept: value => Date.now() < deadlineAt && chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting"
        && planDecisionSourceComplete(value.observation) && planDecisionWorkReady(value.observation),
      reject: value => value.observation.runs.length > 3 || value.observation.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Plan decision contains failed, cancelled or excess native work" : undefined });
    const original = entity(state, "original");
    if (scenarioId.endsWith("reject-and-revise")) {
      const card = ctx.input.page.locator(`#interaction-${original.id}`); await expect(card).toContainText(/Declined|Superseded/i); state.rejectedReceiptVisible = true; return;
    }
    // A separate additional review opens before its actual public document edit.
    // The first canonical approval's source plan is never rewritten by this check.
    const target = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, { title: "Separate stale review fixture", status: "backlog" });
    state.staleTaskId = target.id;
    const old = await putDocument(ctx, target.id, "Old review: unrestricted publication.");
    const stale = await ctx.input.api.post<Interaction>(`/api/issues/${target.id}/interactions`, createIssueThreadInteractionSchema.parse({ kind: "request_confirmation", title: "Review before edit", resolverPolicy: "human_only", continuationPolicy: "none",
      payload: { version: 1, prompt: "Approve the currently opened older review?", supersedeOnUserComment: false, target: { type: "issue_document", issueId: target.id, documentId: old.id, key: "plan", revisionId: old.latestRevisionId, revisionNumber: old.latestRevisionNumber } } }));
    const current = await putDocument(ctx, target.id, "Newer review: local draft only, do not publish.", old.latestRevisionId!);
    const response = await ctx.input.page.context().request.post(`${ctx.input.api.baseURL}/api/issues/${target.id}/interactions/${stale.id}/accept`, { data: {}, headers: { Origin: ctx.input.api.baseURL } });
    state.staleAttemptStatus = response.status(); const body = await response.json() as { code?: string; details?: { code?: string } }; state.staleErrorCode = body.details?.code ?? body.code;
    state.staleRevisionId = old.latestRevisionId; state.newerRevisionId = current.latestRevisionId;
    const interactions = await ctx.input.api.get<Interaction[]>(`/api/issues/${target.id}/interactions`); state.staleExpired = interactions.find(row => row.id === stale.id)?.status === "expired";
    const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${target.identifier ?? target.id}`, { waitUntil: "domcontentloaded" });
    // The supported plan deep link expands the real current document, not text fabricated by the harness.
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${target.identifier ?? target.id}#document-plan&viewer=full`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Newer review: local draft only, do not publish.", { exact: false }).first()).toBeVisible(); state.newerRevisionVisible = true;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await ctx.input.evidence("identity-stale-plan-review.json", { oldRevisionId: old.latestRevisionId, newRevisionId: current.latestRevisionId, staleAttemptStatus: state.staleAttemptStatus, staleErrorCode: state.staleErrorCode, newerRevisionVisible: true });
  },
  observe: observePlanReview,
  async verifyResult(ctx, state, value) {
    const o = identityObservation(value);
    if (scenarioId.endsWith("review-plan") || o?.tasks.length) { await verifyInternalResult(ctx, state, value); return; }
    const doc = o?.documents.find(row => o.revisions.some(revision => revision.id === row.latestRevisionId && revision.documentId === row.id && revision.createdByRunId)
      && (row.body ?? "").includes(String(state.scopeMarker)));
    if (!doc) throw new Error("Actual local review draft is missing");
    const href = await ctx.input.page.locator('[id^="comment-"] a[href]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
    const reviewLink = href.find(link => link.includes(`#document-${encodeURIComponent(doc.key!)}`));
    if (!reviewLink) throw new Error("Actual draft review link missing from reply");
    await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(reviewLink)}]`).first().click();
    await expect(ctx.input.page.getByText(String(state.scopeMarker), { exact: false }).first()).toBeVisible();
  },
}));
