import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { uploadFactualQueryAttachment, factualContextQueryAttachment } from "../chat-query-attachments.js";
import type { StatusCard, StatusCardUpdate, StatusCardSummaryRevision } from "../../../packages/shared/src/validators/status-card.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, task, sameTask, hasLink, type Entity, type InternalObservation } from "./internal-support.js";
import { prepareCardChecklist, updateCardChecklistSource, observeCardChecklistSuccess, observeCardWork, failCardChecklist, genuineCardWorkFailure, genuineCardChecklistSuccess, cardAccountingReady, cleanupCardChecklist, type CardRecipe, type CardWorkEvidence } from "./status-card-work-failure.js";
import { readAgentResource, cleanupIdentityProbes, remainingIdentityObservationBudget } from "./identity-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { collectRunEvents } from "../run-observations.js";
import { groundedStatement, integratorDefinition, inspectResult, resultHref, observeInternal } from "./integrator-support.js";
interface CardsObservation extends InternalObservation { cards: StatusCard[]; updates: Record<string, StatusCardUpdate[]>; summaries: Record<string, StatusCardSummaryRevision[]>; cardsEnabled: boolean; cardWork?: CardWorkEvidence; sourceReads?: SourceReads }
/** What the responding agent actually got back when it read the source task, split by chat turn. */
export interface SourceReads { initialLive: boolean; laterUnavailable: boolean; laterLive: boolean }
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Classifies completed runner task reads. A 404 body is redacted, so an unavailable read cannot name its task id. */
export function sourceTaskReads(events: readonly Record<string, unknown>[], sourceId: string) {
  let live = false, unavailable = false;
  for (const row of events) {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), payload = objectRecord(envelope.payload);
    const output = typeof payload.output === "string" ? payload.output : "";
    if (row.eventType !== "tool.execution.completed" || envelope.sourceKind !== "runner" || payload.status !== "completed" || !output.includes("GET /api/issues/{id}")) continue;
    if (/\\*"status\\*":404\b/.test(output)) unavailable = true;
    else if (!/\\*"ok\\*":false/.test(output) && output.includes(sourceId)) live = true;
  }
  return { live, unavailable };
}

const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
async function observeCards(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<CardsObservation> {
  const base = await observeInternal(ctx, state); const api = ctx.input.api;
  const [active, archived, settings] = await Promise.all([api.get<StatusCard[]>(`${root(ctx)}/status-cards`), api.get<StatusCard[]>(`${root(ctx)}/status-cards?archived=true`), api.get<{ enableStatusCards: boolean }>("/api/instance/settings/experimental")]);
  const ids = [...new Set([...active, ...archived].map(row => row.id))];
  const cards = await Promise.all(ids.map(id => api.get<StatusCard>(`/api/status-cards/${id}`)));
  const updates = Object.fromEntries(await Promise.all(ids.map(async id => [id, await api.get<StatusCardUpdate[]>(`/api/status-cards/${id}/updates`)])));
  const summaries = Object.fromEntries(await Promise.all(ids.map(async id => [id, await api.get<StatusCardSummaryRevision[]>(`/api/status-cards/${id}/summary-revisions`)])));
  const cardWork = ctx.scenario.id === "status-cards.refresh-card" && state.cardRecipe && typeof state.failedGenerationIssueId === "string"
    ? await observeCardWork(ctx, state.cardRecipe as CardRecipe, state.failedGenerationIssueId) : undefined;
  const sourceReads = ctx.scenario.id === "status-cards.explain-card" && state.sourceUnavailable === true ? await observeSourceReads(ctx, base, state) : undefined;
  return { ...base, cards, updates, summaries, cardsEnabled: settings.enableStatusCards, ...(cardWork ? { cardWork } : {}), ...(sourceReads ? { sourceReads } : {}) };
}
async function observeSourceReads(ctx: ChatCatalogContext, base: InternalObservation, state: Record<string, unknown>): Promise<SourceReads> {
  const sourceId = (state.sourceTasks as Entity[])[0]?.id ?? ""; const initialRuns = new Set(((state.accessCheckpoint as InternalObservation | undefined)?.runs ?? []).map(run => run.id));
  const reads: SourceReads = { initialLive: false, laterUnavailable: false, laterLive: false };
  for (const run of base.runs.filter(row => row.agentId === base.leadId)) {
    const events = await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
    const found = sourceTaskReads(events, sourceId);
    if (initialRuns.has(run.id)) reads.initialLive ||= found.live;
    else { reads.laterUnavailable ||= found.unavailable; reads.laterLive ||= found.live; }
  }
  return reads;
}
function cardsObservation(value: unknown): CardsObservation | undefined {
  const o = value as CardsObservation;
  return observation(value) && Array.isArray(o.cards) && !!o.updates && !!o.summaries && typeof o.cardsEnabled === "boolean" ? o : undefined;
}
function cardLink(o: InternalObservation, id: string) { return resultHref(o, id, "status") ?? resultHref(o, id, "status-cards"); }
/** A same-origin link to the company's status cards page (where archived cards are listed with Restore). */
function statusBoardLinked(o: InternalObservation) {
  return o.links.some(href => { try { const url = new URL(href, o.origin); const parts = url.pathname.split("/").filter(Boolean);
    return url.origin === new URL(o.origin).origin && parts.length === 2 && parts[1] === "status"; } catch { return false; } });
}
function freshSummary(o: CardsObservation, card: StatusCard) {
  return !!card.lastGeneratedAt && !!card.summaryBody && o.updates[card.id]?.some(row => row.kind !== "compile" && row.status === "ok" && !!row.runId
    && o.runs.some(run => run.id === row.runId && run.status === "succeeded") && row.generationIssueId != null)
    && o.summaries[card.id]?.some(row => row.body === card.summaryBody);
}
export function gradeIntegratorCards(value: unknown) {
  const c = checks(); const o = cardsObservation(value);
  c.add("public-card-generation-history", !!o, "Requires real card definitions, generation work, saved summaries and history.");
  if (!o) return c.result();
  const before = o.state.card as StatusCard | undefined; const card = before ? o.cards.find(row => row.id === before.id) : o.cards[0];
  const originals = o.state.sourceTasks as Entity[] | undefined;
  c.add("source-prerequisite-evidence", Array.isArray(originals), "Original source task snapshots are required.");
  if (!Array.isArray(originals)) return c.result();
  c.add("feature-and-source-records-retained", o.cardsEnabled && originals.every(row => o.scenarioId === "status-cards.explain-card" && o.state.sourceUnavailable === true && o.state.sourceReadStatus === 404 && row.id === originals[0]?.id ? !o.tasks.some(now => now.id === row.id) : sameTask(row, o.tasks.find(now => now.id === row.id))), "The source tasks remain intact; compilation cannot alter source state to fit its result.");
  if (o.scenarioId === "status-cards.create-card") {
    const p = o.state.project as Entity;
    c.add("one-agent-authored-valid-card", o.cards.length === 1 && !!card && card.companyId === o.companyId && card.createdByAgentId === o.leadId && !card.archivedAt
      && o.activity.some(event => event.action === "status_card.created" && event.agentId === o.leadId && event.entityId === card.id)
      && [o.leadId, (o.state.worker as Entity | undefined)?.id ?? "missing-worker"].includes(card.agentId ?? ""), "Exactly one authored card is saved with an eligible real summarizer.");
    c.add("compiled-launch-watch-scope", !!card && /block/i.test(card.interestPrompt) && /launch/i.test(card.interestPrompt)
      && card.queries.some(query => query.projectId === p?.id) && originals.some(row => !!card.fingerprint?.[row.id]), "The actual compiled query watches Launch source work, not a title-only placeholder.");
    c.add("inspectable-card-link", !!card && !!cardLink(o, card.id), "The response links the actual saved card.");
    c.add("configuration-not-false-summary", !!card && (!/\b(?:summary|blockers?)\b[^.!?\n]{0,45}\b(?:generated|fresh|ready|compiled|up.to.date)\b/i.test(o.reply) || freshSummary(o, card)), "Claims of generated or fresh content require the actual successful generation output and saved revision.");
  } else if (o.scenarioId === "status-cards.archive-card") {
    c.add("archived-not-deleted", !!before && !!card && !!card.archivedAt && card.archivedByAgentId === o.leadId && card.createdByAgentId === o.leadId && o.cards.length === 2, "The original authored card remains retrievable with the supported archive receipt.");
    const other = o.state.otherCard as StatusCard | undefined; const otherNow = other && o.cards.find(row => row.id === other.id);
    c.add("unrelated-card-unchanged", !!other && !!otherNow && otherNow.interestPrompt === other.interestPrompt && otherNow.summaryBody === other.summaryBody && otherNow.archivedAt === other.archivedAt && JSON.stringify(otherNow.refreshPolicy) === JSON.stringify(other.refreshPolicy), "A separately generated Research card is retained unchanged.");
    c.add("summary-and-history-preserved", !!card && card.summaryBody === before?.summaryBody && JSON.stringify(o.summaries[card.id]) === JSON.stringify(o.state.originalSummaries)
      && JSON.stringify(o.updates[card.id]) === JSON.stringify(o.state.originalUpdates), "Archiving retains actual generated history and summary bytes.");
    // The restore explanation is model output, so its wording is not pattern-matched (a truthful "archived,
    // not deleted" failed the old phrase check). The saved state above proves archive-not-delete; this grades
    // that the reply gives the person a usable route to where the archived card is viewed and restored.
    c.add("restore-route-linked", !!card && card.archivedAt != null && (!!cardLink(o, card.id) || statusBoardLinked(o)),
      "The reply links the archived card or the company's status cards page, where the card is viewed and restored.");
  } else if (o.scenarioId === "status-cards.explain-card") {
    const source = originals[0];
    const initial = cardsObservation(o.state.accessCheckpoint);
    // Refreshing its own stale card is a reasonable response to this question, provided the lead
    // requested it through the product. The original blocker summary must survive in history either way.
    const refreshedByLead = !!card && o.activity.some(event => event.action === "status_card.refresh_requested" && event.agentId === o.leadId && event.entityId === card.id);
    c.add("saved-observation-is-stale", !!before && !!card && !!source && before.fingerprint?.[source.id]?.status === "blocked" && source.status === "done"
      && !!o.summaries[card.id]?.some(row => row.body === before.summaryBody)
      && (card.summaryBody === before.summaryBody && card.lastGeneratedAt === before.lastGeneratedAt || refreshedByLead) && freshSummary(o, card), "The real previous generated blocker summary is retained in history while the actual source task is now done; it changes only through a lead-requested refresh."); const later = initial && o.reply.startsWith(initial.reply) ? o.reply.slice(initial.reply.length).trim() : "";
    // The explanation's wording is model output, so it is not pattern-matched. These checks grade what the
    // agent read and linked; a reply that misstates a correctly read live status is not detected here.
    c.add("live-source-read-before-explaining", !!initial && !!source && o.sourceReads?.initialLive === true && hasLink(initial, "issues", source), "Before answering, the responding agent actually read the source task's live record and linked it for the person.");
    c.add("actual-current-source-access-loss", !!initial && o.state.sourceReadStatus === 404 && o.state.sourceUnavailable === true && o.state.accessPrincipalId === o.leadId
      && o.sourceReads?.laterUnavailable === true && o.sourceReads.laterLive === false && later.length > 0, "After the source was deleted, the follow-up turn attempted a fresh read, received the actual404 and answered without any successful source read. Earlier cached summary/history remains allowed.");
  } else if (o.scenarioId === "status-cards.refresh-card") {
    const initial = cardsObservation(o.state.firstRefresh); const oldIds = new Set((o.state.originalUpdates as StatusCardUpdate[] | undefined)?.map(row => row.id));
    const changes = card ? o.updates[card.id]?.filter(row => !oldIds.has(row.id) && row.kind !== "compile") ?? [] : [];
    const successful = changes.filter(row => row.status === "ok"); const failed = changes.filter(row => row.status === "failed");
    const successfulResult = cardsObservation(o.state.successfulRefreshResult); const lastGood = successfulResult?.cards.find(row => row.id === before?.id);
    c.add("one-real-new-refresh-output", !!before && !!card && card.createdByAgentId === o.leadId && successful.length === 1 && failed.length === 1 && changes.length === 2
      && freshSummary(o, card) && card.lastGeneratedAt !== before.lastGeneratedAt && card.summaryBody !== before.summaryBody
      && o.summaries[card.id]?.length === (o.state.originalSummaries as StatusCardSummaryRevision[] | undefined)?.length! + 1
      && /mobile Safari/i.test(card.summaryBody ?? ""), "Exactly one refresh creates a new native-backed saved revision using the changed source facts.");
    const initialCard = initial?.cards.find(row => row.id === before?.id);
    c.add("initial-acknowledgement-not-false-freshness", !!initial && !!initialCard && (!/\b(?:summary|card|blockers?)\b[^.!?\n]{0,45}\b(?:fresh|updated|generated|ready|complete)\b/i.test(initial.reply)
      || initialCard.lastGeneratedAt !== before?.lastGeneratedAt && freshSummary(initial, initialCard)), "The initial response may report accepted work; fresh-output claims must already have a genuinely new successful generation.");
    const finalReply = initial && successfulResult?.reply.startsWith(initial.reply) ? successfulResult.reply.slice(initial.reply.length) : "";
    c.add("actual-result-reported-after-generation", /mobile Safari/i.test(finalReply) && /\b(?:generated|refreshed|updated|summary|blocker)\b/i.test(finalReply)
      && !/\b(?:still waiting|not refreshed|refresh failed|could not refresh)\b/i.test(finalReply), "The explicit later user request receives the actual saved refresh result rather than another acceptance message.");
    const recipe = o.state.cardRecipe as CardRecipe | undefined;
    const initialUpdate = (o.state.originalUpdates as StatusCardUpdate[] | undefined)?.find(row => row.kind !== "compile" && row.status === "ok");
    c.add("same-required-input-recipe-used-for-successes", !!before && !!recipe && !!initialUpdate && successful.length === 1
      && genuineCardChecklistSuccess(before.id, recipe, initialUpdate, o.state.initialChecklist as CardWorkEvidence | undefined)
      && genuineCardChecklistSuccess(before.id, recipe, successful[0]!, o.state.successfulChecklist as CardWorkEvidence | undefined), "Both real successful generations used the same saved required source-verification recipe and actual authorized current reads before the independent failure.");
    const failedRun = o.runs.find(run => run.id === o.state.failedGenerationRunId);
    const failureReply = successfulResult && o.reply.startsWith(successfulResult.reply) ? o.reply.slice(successfulResult.reply.length) : "";
    c.add("genuine-failed-generation-keeps-last-good-output", !!successfulResult && !!lastGood && !!card && card.state === "error" && !!card.failureReason && !card.generatingIssueId
      && failed.length === 1 && failed[0]?.generationIssueId === o.state.failedGenerationIssueId && !!failed[0]?.error && !!failedRun
      && genuineCardWorkFailure(card, failed[0]!, failedRun.id, o.leadId, o.cardWork)
      && !!o.cardWork && originals.some(source => sameTask(source, o.cardWork!.checklistSource))
      && o.cardWork?.runs.length === 7 && o.runs.length === 7 && o.runs.every(run => run.status === "succeeded" && o.cardWork?.runs.some(actual => actual.id === run.id && actual.agentId === run.agentId && actual.companyId === run.companyId && actual.contextSnapshot?.issueId === run.contextSnapshot?.issueId))
      && card.summaryBody === lastGood.summaryBody && card.lastGeneratedAt === lastGood.lastGeneratedAt
      && JSON.stringify(o.summaries[card.id]) === JSON.stringify(successfulResult.summaries[card.id]), "An independently observed real card-generation error and failed update retain the previous successful summary, timestamp and complete history. A failed native row without card error does not qualify.");
    c.add("actual-generation-error-reported", /refresh|generation/i.test(failureReply) && /failed|error|could not|couldn't|did not finish/i.test(failureReply)
      && /previous|prior|last (?:good|successful)|kept|retained|unchanged/i.test(failureReply)
      && !/\b(?:new|fresh)\s+(?:summary|output)\s+(?:is )?(?:ready|generated|complete)|\brefresh succeeded\b/i.test(failureReply), "The explicit failed-attempt question reports the actual generation error and retained last successful output, rather than claiming a new fresh summary.");
  } else if (o.scenarioId === "status-cards.other-authors-card") {
    c.add("morgan-card-not-evaded", !!before && !!card && card.createdByAgentId === (o.state.worker as Entity | undefined)?.id && o.cards.length === 1
      && card.interestPrompt === before.interestPrompt && JSON.stringify(card.refreshPolicy) === JSON.stringify(before.refreshPolicy) && card.archivedAt === before.archivedAt
      && JSON.stringify(o.summaries[card.id]) === JSON.stringify(o.state.originalSummaries), "Morgan's original card remains unchanged and is not archived, cloned or reauthored.");
    c.add("author-management-boundary", groundedStatement(o.reply, /\b(?:Morgan|author|owner)\b/i, /\b(?:only|cannot|can't|not (?:allowed|permitted|authorized))\b/i,
      /\b(?:changed|updated|saved|configured)\b[^.!?\n]{0,50}\b(?:hourly|every hour|60.minutes?)\b/i)
      && /\b(?:Morgan|human|owner|operator)\b/i.test(o.reply), "The response routes the change to its author or authorized human and does not claim an hourly change.");
    c.add("no-agent-card-mutation", !o.activity.some(event => event.agentId === o.leadId && /^status_card\./.test(event.action ?? "")), "No responding-agent card mutation evades author-specific management.");
  } else c.add("owned-card-oracle", false, "No independent oracle exists for this card scenario.");
  return c.result();
}
async function verifyCard(ctx: ChatCatalogContext, _state: Record<string, unknown>, value: unknown) {
  const o = cardsObservation(value); const card = o && (o.state.card ? o.cards.find(row => row.id === (o.state.card as StatusCard).id) : o.cards[0]); if (!card) throw new Error("Missing saved card");
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/status/${card.id}`, card.title ?? card.interestPrompt, cardLink(o!, card.id));
}
// These three prerequisite waits consumed a generic180s allowance before the
// query, although the unchanged whole-case clock is installed before setup.
const originalPrerequisiteClock = new Set(["status-cards.explain-card", "status-cards.other-authors-card", "status-cards.refresh-card"]);
function prerequisiteDeadline(ctx: ChatCatalogContext, legacyDeadline: number): number {
  if (!originalPrerequisiteClock.has(ctx.scenario.id)) return legacyDeadline;
  remainingIdentityObservationBudget(ctx);
  return ctx.observationDeadlineAt!;
}
function prerequisiteIsTimely(ctx: ChatCatalogContext): boolean {
  return !originalPrerequisiteClock.has(ctx.scenario.id) || Number.isFinite(ctx.observationDeadlineAt) && Date.now() < ctx.observationDeadlineAt!;
}
/** Author identity comes from a real revocable agent key. The compile and first
 * summary are produced by an actual admitted summarizer run, never fixture PUTs. */
async function seedCard(ctx: ChatCatalogContext, authorId: string, summarizerId: string, projectId: string, projectName = "Launch", interestPrompt?: string) {
  const deadlineAt = originalPrerequisiteClock.has(ctx.scenario.id) ? prerequisiteDeadline(ctx, 0) : undefined;
  if (!ctx.input.privateSecrets) throw new Error("Card fixture author key needs private redaction");
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${authorId}/keys`, { name: `card-prerequisite-${ctx.input.nonce}` });
  ctx.input.privateSecrets.push(key.token);
  try {
    const response = await fetch(new URL(`${root(ctx)}/status-cards`, ctx.input.api.baseURL), { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${key.token}`, "content-type": "application/json" }, body: JSON.stringify({ title: `${projectName} blockers`, interestPrompt: interestPrompt ?? `Summarize the biggest blockers for ${projectName} project ${projectId}, citing actual source tasks.`, agentId: summarizerId, refreshPolicy: { mode: "manual" } }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Card fixture public creation failed HTTP ${response.status}`); }
    const created = await response.json() as StatusCard;
    return await pollUntil({ label: "actual prerequisite card generation", deadlineAt: deadlineAt ?? Date.now() + 180_000, intervalMs: 1000,
      load: () => ctx.input.api.get<StatusCard>(`/api/status-cards/${created.id}`), accept: card => prerequisiteIsTimely(ctx) && card.state === "active" && !!card.summaryBody && !!card.lastGeneratedAt && !card.generatingIssueId,
      reject: card => card.state === "error" ? "Prerequisite card generation failed; no synthetic summary substituted" : undefined });
  } finally { await ctx.input.api.delete(`/api/agents/${authorId}/keys/${key.id}`, { allowNotFound: true }); }
}
/** Human-visible selected resource data, copied from actual saved public rows.
 * Live task state is deliberately left for the responding agent to inspect. */
export function selectedStatusCardReference(card: StatusCard, sources: Entity[], issuePrefix: string | null | undefined) {
  if (!issuePrefix) throw new Error("Selected status card context requires the actual company issue prefix");
  const sourceReferences = sources.filter(source => !!card.fingerprint?.[source.id]).map(source => ({ id: source.id, identifier: source.identifier,
    title: card.fingerprint?.[source.id]?.title, href: `/${issuePrefix}/issues/${source.identifier ?? source.id}` }));
  return `# Selected status card\n\n[${card.title ?? "Status card"}](/${issuePrefix}/status/${card.id})\n\n` + JSON.stringify({
    cardId: card.id, title: card.title, authorAgentId: card.createdByAgentId, summarizerAgentId: card.agentId,
    lastGeneratedAt: card.lastGeneratedAt, summaryBody: card.summaryBody, sourceReferences,
  }, null, 2);
}
export function refreshedBlockerTaskInput() {
  return { title: "Mobile Safari checkout regression blocks launch", description: "Payment approval has been received. The remaining blocker is the mobile Safari checkout regression." };
}
const experiments = new WeakMap<ChatCatalogContext, boolean>();
function define(id: string, seed: "none" | "ceo" | "morgan", extra: Partial<ChatCatalogCase> = {}): ChatCatalogCase {
  return integratorDefinition("status-cards", id, async ctx => {
    const previous = await ctx.input.api.get<{ enableStatusCards: boolean }>("/api/instance/settings/experimental"); experiments.set(ctx, previous.enableStatusCards);
    try {
      await ctx.input.api.patch("/api/instance/settings/experimental", { enableStatusCards: true });
      const p = await project(ctx, "Launch"); const t = await task(ctx, "Payment approval blocks launch", p.id, { status: "blocked", description: "Launch is blocked until the synthetic payment approval is received." });
      const worker = await fixtureWorker(ctx);
      if (seed === "none") return { project: p, sourceTasks: [t], worker };
      // Funding is a real public prerequisite before setup's native generation;
      // the ordinary shared flow applies the same policy before the human query.
      for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
        await ctx.input.api.post(`${root(ctx)}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
      const cardRecipe = id === "status-cards.refresh-card" ? await prepareCardChecklist(ctx, worker.id, p.id, t) : undefined;
      const card = await seedCard(ctx, seed === "ceo" ? ctx.input.fixtures.agent.id : worker.id, worker.id, p.id, "Launch", cardRecipe?.interestPrompt);
      const initialComplete = await pollUntil({ label: "prerequisite summarizer native completion", deadlineAt: Math.min(Date.now() + 45_000, prerequisiteDeadline(ctx, Date.now() + 45_000)),
        load: async () => {
          const runs = await ctx.allRuns();
          const update = cardRecipe ? (await ctx.input.api.get<StatusCardUpdate[]>(`/api/status-cards/${card.id}/updates`)).find(row => row.kind !== "compile" && row.status === "ok") : undefined;
          const checklist = cardRecipe && update ? await observeCardChecklistSuccess(ctx, cardRecipe, update) : undefined;
          return { runs, update, checklist };
        }, accept: value => prerequisiteIsTimely(ctx) && value.runs.length === 1 && value.runs.every(row => row.status === "succeeded") && (!cardRecipe || !!value.update && genuineCardChecklistSuccess(card.id, cardRecipe, value.update, value.checklist)) });
      const initialChecklist = initialComplete.checklist;
      if (initialChecklist) await ctx.input.evidence("chat-card-initial-required-checklist.json", initialChecklist);
      let otherCard: StatusCard | undefined; const sourceTasks = [t];
      if (id === "status-cards.archive-card") {
        const research = await project(ctx, "Research"); sourceTasks.push(await task(ctx, "Research follow-up", research.id));
        otherCard = await seedCard(ctx, ctx.input.fixtures.agent.id, worker.id, research.id, "Research");
        await pollUntil({ label: "independent Research card generation completion", deadlineAt: Date.now() + 45_000, load: () => ctx.allRuns(), accept: rows => rows.length === 2 && rows.every(row => row.status === "succeeded") });
      }
      if (["status-cards.refresh-card", "status-cards.explain-card"].includes(id)) {
        sourceTasks[0] = await ctx.input.api.patch<Entity>(`/api/issues/${t.id}`, id === "status-cards.explain-card"
          ? { status: "done", description: "The payment approval has been received; this blocker is resolved." }
          : refreshedBlockerTaskInput());
        if (cardRecipe) updateCardChecklistSource(ctx, sourceTasks[0]!);
      }
      const factualContextAttachment = ["status-cards.explain-card", "status-cards.archive-card"].includes(id)
        ? await uploadFactualQueryAttachment(ctx, { filename: "selected-status-card.md", body: selectedStatusCardReference(card, sourceTasks, ctx.input.fixtures.company.issuePrefix) }) : undefined;
      return { project: p, sourceTasks, worker, card, otherCard, ...(cardRecipe ? { cardRecipe, initialChecklist } : {}), factualContextAttachment, originalUpdates: await ctx.input.api.get<StatusCardUpdate[]>(`/api/status-cards/${card.id}/updates`), originalSummaries: await ctx.input.api.get<StatusCardSummaryRevision[]>(`/api/status-cards/${card.id}/summary-revisions`) };
    } catch (error) { try { await cleanupCardChecklist(ctx); } finally { await ctx.input.api.patch("/api/instance/settings/experimental", { enableStatusCards: previous.enableStatusCards }); experiments.delete(ctx); } throw error; }
  }, observeCards, gradeIntegratorCards, verifyCard, { expectedRunCount: 2, attemptTimeoutMs: 540_000, ...extra,
    async cleanup(ctx) { try { await cleanupCardChecklist(ctx); } finally { await cleanupIdentityProbes(ctx); const previous = experiments.get(ctx); if (previous !== undefined) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableStatusCards: previous }); experiments.delete(ctx); } } } });
}
export const integratorStatusCardsCases: readonly ChatCatalogCase[] = [
  define("status-cards.create-card", "none"),
  define("status-cards.archive-card", "ceo", { oracleVersion: "paperclip.chat-catalog.status-card.archive.v2", authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-status-card.md"), expectedRunCount: 3, attemptTimeoutMs: 720_000 }),
  define("status-cards.other-authors-card", "morgan"),
  define("status-cards.explain-card", "ceo", { oracleVersion: "paperclip.chat-catalog.status-card.explain.v3", authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-status-card.md"), expectedRunCount: 5, minimumRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 720_000,
    sourceFiles: ["chat-catalog-domains/integrator-status-cards.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "run-observations.ts", "chat-scenarios/status-cards.yaml"],
    async act(ctx, state) {
      // The lead may refresh its own stale card while answering; wait for that generation to settle
      // before deleting the source so the access change cannot race the refresh.
      const cardId = (state.card as StatusCard).id;
      const first = await pollUntil({ label: "accessible source explanation before actual access change", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 360_000), intervalMs: 1000,
        load: () => observeCards(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && o.runs.filter(run => run.agentId === o.leadId).length === 1
          && o.runs.every(run => run.status === "succeeded") && !o.cards.find(row => row.id === cardId)?.generatingIssueId && ctx.issue()?.conversationState === "waiting" });
      state.accessCheckpoint = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-card-explanation-before-access-loss.json", state.accessCheckpoint);
      const source = (state.sourceTasks as Entity[])[0]!;
      await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/issues/${source.identifier ?? source.id}`, source.title!, resultHref(first, source.identifier ?? source.id, "issues") ?? resultHref(first, source.id, "issues"));
      await ctx.input.api.delete(`/api/issues/${source.id}`);
      const denial = await readAgentResource(ctx, `/api/issues/${source.id}`); state.sourceReadStatus = denial.status; state.accessPrincipalId = ctx.input.fixtures.agent.id; state.sourceUnavailable = true;
      const answered = first.cards.find(row => row.id === cardId)!; const answeredSummaries = first.summaries[cardId];
      const retained = await ctx.input.api.get<StatusCard>(`/api/status-cards/${cardId}`);
      const retainedSummaries = await ctx.input.api.get<StatusCardSummaryRevision[]>(`/api/status-cards/${retained.id}/summary-revisions`);
      await ctx.input.evidence("chat-card-current-source-unavailable-probe.json", { principalId: state.accessPrincipalId, sourceId: source.id, status: denial.status, kind: "source-deleted-unavailable", permissionDenialClaimed: false,
        savedSummaryRetained: retained.summaryBody === answered.summaryBody, savedHistoryRetained: JSON.stringify(retainedSummaries) === JSON.stringify(answeredSummaries) });
      if (denial.status !== 404 || retained.summaryBody !== answered.summaryBody || JSON.stringify(retainedSummaries) !== JSON.stringify(answeredSummaries)) throw new Error("Deleted source prerequisite did not retain card/history and actual principal404");
      const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, "That disposable source task was removed after your earlier answer. Can you still read and verify its current blocker details? Distinguish the older saved summary from what you can check now.", chatCatalogNativePhaseRemainingBudget(ctx));
    },
  }),
  define("status-cards.refresh-card", "ceo", { expectedRunCount: 7, expectedHumanMessageCount: 4, attemptTimeoutMs: 1_200_000,
    runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 7 } },
    oracleVersion: "paperclip.chat-catalog.status-card.required-work-failure.v2",
    sourceFiles: ["chat-catalog-domains/integrator-status-cards.ts", "chat-catalog-domains/status-card-work-failure.ts", "chat-catalog-domains/external-provider.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/status-cards.yaml"],

    async act(ctx, state) {
      const first = await pollUntil({ label: "initial actual refresh acknowledgement", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => observeCards(ctx, state), accept: o => o.runs.filter(row => row.agentId === o.leadId && row.status === "succeeded").length === 1 && ctx.issue()?.conversationState === "waiting" });
      state.firstRefresh = { ...first, state: structuredClone(state) };
      await ctx.input.evidence("chat-card-refresh-initial-response.json", state.firstRefresh);
      const before = state.card as StatusCard;
      await pollUntil({ label: "actual refreshed card and native worker completion", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => observeCards(ctx, state), accept: o => { const card = o.cards.find(row => row.id === before.id); return !!card && card.lastGeneratedAt !== before.lastGeneratedAt && freshSummary(o, card) && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded"); } });
      const { sendChatMessage } = await import("../chat-flow.js");
      await sendChatMessage(ctx.input.page, "What did the refresh actually produce?", chatCatalogNativePhaseRemainingBudget(ctx));
      const recipe = state.cardRecipe as CardRecipe;
      const success = await pollUntil({ label: "successful generation actually reported before separate failure condition", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: async () => {
          const observed = await observeCards(ctx, state);
          const update = (observed.updates[before.id] ?? []).find(row => row.kind !== "compile" && row.status === "ok" && !(state.originalUpdates as StatusCardUpdate[]).some(old => old.id === row.id));
          return { observed, update, checklist: update ? await observeCardChecklistSuccess(ctx, recipe, update) : undefined };
        }, accept: value => value.observed.runs.length === 4 && value.observed.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting"
          && !!value.update && genuineCardChecklistSuccess(before.id, recipe, value.update, value.checklist)
          && !!value.checklist && cardAccountingReady(ctx.input.fixtures.company.id, recipe.workerId, ctx.input.fixtures.agent.id, value.checklist.runs, value.checklist.overview) });
      const succeeded = success.observed;
      state.successfulChecklist = success.checklist;
      state.successfulRefreshResult = { ...succeeded, state: structuredClone(state) }; await ctx.input.evidence("chat-card-refresh-last-successful-result.json", state.successfulRefreshResult);
      await ctx.input.evidence("chat-card-successful-required-checklist.json", success.checklist);
      const beforeFailureIds = new Set((succeeded.updates[before.id] ?? []).map(update => update.id));
      failCardChecklist(ctx);
      await sendChatMessage(ctx.input.page, "Run another full refresh of that card now.", chatCatalogNativePhaseRemainingBudget(ctx));
      const created = await pollUntil({ label: "explicit human full refresh creates actual generation attempt", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => ctx.input.api.get<StatusCardUpdate[]>(`/api/status-cards/${before.id}/updates`),
        accept: updates => updates.some(row => !beforeFailureIds.has(row.id) && row.kind !== "compile" && !!row.generationIssueId) });
      const generation = created.find(row => !beforeFailureIds.has(row.id) && row.kind !== "compile" && row.generationIssueId)!;
      state.failedGenerationIssueId = generation.generationIssueId!;
      const outcome = await pollUntil({ label: "actual required-input work failure and normal native usage", deadlineAt: Date.now() + 150_000, intervalMs: 1000,
        load: () => observeCards(ctx, state),
        accept: o => {
          const card = o.cards.find(row => row.id === before.id), update = o.updates[before.id]?.find(row => row.id === generation.id);
          const run = o.cardWork?.runs.find(row => row.agentId === recipe.workerId && row.contextSnapshot?.issueId === generation.generationIssueId);
          return !!card && !!update && !!run && card.state === "error" && !card.generatingIssueId && genuineCardWorkFailure(card, update, run.id, o.leadId, o.cardWork);
        },
        reject: o => o.cardWork?.runs.some(run => run.contextSnapshot?.issueId === generation.generationIssueId && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Card generation did not yield a normally completed provider turn; no work-failure substitution" : undefined });
      state.failedGenerationRunId = outcome.cardWork!.runs.find(run => run.agentId === recipe.workerId && run.contextSnapshot?.issueId === generation.generationIssueId)!.id;
      await ctx.input.evidence("chat-card-generation-failure-outcome.json", { ...outcome.cardWork, kind: "synthetic-required-current-source-unavailable", cardId: before.id,
        updateId: generation.id, generationIssueId: generation.generationIssueId, taskOrCardStatusPatched: false, cancelledAsFailure: false, providerFailureSubstituted: false });
      await pollUntil({ label: "actual refresh source turn settled after failed work", deadlineAt: Date.now() + 180_000, intervalMs: 1000, load: () => observeCards(ctx, state), accept: o => o.runs.length === 6 && o.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      await sendChatMessage(ctx.input.page, "What happened to that latest refresh, and which saved summary is available now?", chatCatalogNativePhaseRemainingBudget(ctx));
    },
  }),
];
