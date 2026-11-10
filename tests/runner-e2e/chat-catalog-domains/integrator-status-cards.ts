import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { uploadFactualQueryAttachment, factualContextQueryAttachment } from "../chat-query-attachments.js";
import type { StatusCard, StatusCardUpdate, StatusCardSummaryRevision } from "../../../packages/shared/src/validators/status-card.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { checks, observation, project, task, sameTask, hasLink, type Entity, type InternalObservation } from "./internal-support.js";
import { prepareCardChecklist, updateCardChecklistSource, observeCardChecklistSuccess, observeCardWork, failCardChecklist, genuineCardWorkFailure, genuineCardChecklistSuccess, cardAccountingReady, cleanupCardChecklist, type CardRecipe, type CardWorkEvidence } from "./status-card-work-failure.js";
import { readAgentResource, cleanupIdentityProbes, remainingIdentityObservationBudget } from "./identity-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { collectRunEvents } from "../run-observations.js";
import { apiReadDigests, apiReadStatuses, recordParams } from "./api-read-receipts.js";
import { integratorDefinition, inspectResult, resultHref, observeInternal } from "./integrator-support.js";
interface CardsObservation extends InternalObservation { cards: StatusCard[]; updates: Record<string, StatusCardUpdate[]>; summaries: Record<string, StatusCardSummaryRevision[]>; cardsEnabled: boolean; cardWork?: CardWorkEvidence; sourceReads?: SourceReads; cardOperations?: Record<string, string[]> }
/** What the responding agent actually got back when it read the source task, split by chat turn. */
export interface SourceReads { initialLive: boolean; laterUnavailable: boolean; laterLive: boolean }
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Reads that return the card's saved state: the company list and the card both carry state, failureReason and lastGeneratedAt. */
const CARD_STATE_READS = ["GET /api/companies/{companyId}/status-cards", "GET /api/status-cards/{id}"];
/**
 * Status-card reads a run completed successfully for this card (or its company's card list). call_api
 * payloads are redacted before saving, so each read is bound by its input digest and its paired result;
 * a started, failed or other-card request does not count.
 */
export function statusCardOperations(events: readonly Record<string, unknown>[], cardId: string, companyId: string): string[] {
  const card = recordParams("id", cardId), company = [...recordParams("companyId", companyId), undefined];
  const digests = apiReadDigests([
    { operationId: "GET /api/companies/{companyId}/status-cards", pathParams: company, queries: [{ archived: true }, { archived: "true" }, { archived: false }, { archived: "false" }] },
    { operationId: "GET /api/status-cards/{id}", pathParams: card },
    { operationId: "GET /api/status-cards/{id}/summary-revisions", pathParams: card, paged: true },
    { operationId: "GET /api/status-cards/{id}/updates", pathParams: card, paged: true },
  ]);
  return apiReadStatuses(events, digests).filter(read => read.ok && read.status >= 200 && read.status < 300).map(read => read.operationId);
}
/**
 * Classifies this run's reads of the source task. call_api reads are bound to the source by their saved
 * input digest: a successful result is a live read and a 404 is an unavailable one. An unredacted
 * dedicated-tool output naming the source also counts as live.
 */
export function sourceTaskReads(events: readonly Record<string, unknown>[], sourceId: string, identifier?: string | null) {
  const reads = apiReadStatuses(events, apiReadDigests([{ operationId: "GET /api/issues/{id}", pathParams: recordParams("id", sourceId, identifier) }]));
  let live = reads.some(read => read.ok && read.status >= 200 && read.status < 300), unavailable = reads.some(read => read.status === 404);
  for (const row of events) {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), payload = objectRecord(envelope.payload);
    const output = typeof payload.output === "string" ? payload.output : "";
    if (row.eventType !== "tool.execution.completed" || envelope.sourceKind !== "runner" || payload.status !== "completed" || !output.includes("GET /api/issues/{id}")) continue;
    if (!/\\*"ok\\*":false/.test(output) && !/\\*"status\\*":404\b/.test(output) && output.includes(sourceId)) live = true;
  }
  return { live, unavailable };
}

const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
/** Polls pass runEvents: false; only the final observation reads every lead run's tool events. */
async function observeCards(ctx: ChatCatalogContext, state: Record<string, unknown>, options: { runEvents?: boolean } = {}): Promise<CardsObservation> {
  const base = await observeInternal(ctx, state); const api = ctx.input.api;
  const [active, archived, settings] = await Promise.all([api.get<StatusCard[]>(`${root(ctx)}/status-cards`), api.get<StatusCard[]>(`${root(ctx)}/status-cards?archived=true`), api.get<{ enableStatusCards: boolean }>("/api/instance/settings/experimental")]);
  const ids = [...new Set([...active, ...archived].map(row => row.id))];
  const cards = await Promise.all(ids.map(id => api.get<StatusCard>(`/api/status-cards/${id}`)));
  const updates = Object.fromEntries(await Promise.all(ids.map(async id => [id, await api.get<StatusCardUpdate[]>(`/api/status-cards/${id}/updates`)])));
  const summaries = Object.fromEntries(await Promise.all(ids.map(async id => [id, await api.get<StatusCardSummaryRevision[]>(`/api/status-cards/${id}/summary-revisions`)])));
  const cardWork = ctx.scenario.id === "status-cards.refresh-card" && state.cardRecipe && typeof state.failedGenerationIssueId === "string"
    ? await observeCardWork(ctx, state.cardRecipe as CardRecipe, state.failedGenerationIssueId) : undefined;
  const sourceReads = ctx.scenario.id === "status-cards.explain-card" && state.sourceUnavailable === true ? await observeSourceReads(ctx, base, state) : undefined;
  const cardOperations = ctx.scenario.id === "status-cards.refresh-card" && options.runEvents !== false ? await observeCardOperations(ctx, base, (state.card as StatusCard).id) : undefined;
  return { ...base, cards, updates, summaries, cardsEnabled: settings.enableStatusCards, ...(cardWork ? { cardWork } : {}), ...(sourceReads ? { sourceReads } : {}), ...(cardOperations ? { cardOperations } : {}) };
}
async function observeCardOperations(ctx: ChatCatalogContext, base: InternalObservation, cardId: string): Promise<Record<string, string[]>> {
  return Object.fromEntries(await Promise.all(base.runs.filter(run => run.agentId === base.leadId).map(async run => [run.id,
    statusCardOperations(await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`)), cardId, ctx.input.fixtures.company.id)])));
}
/** True when one of the lead's runs in this turn read the card's saved state. */
function turnReadCard(o: CardsObservation, runIds: readonly string[], operations: readonly string[]) {
  return runIds.some(id => o.cardOperations?.[id]?.some(operation => operations.includes(operation)));
}
async function observeSourceReads(ctx: ChatCatalogContext, base: InternalObservation, state: Record<string, unknown>): Promise<SourceReads> {
  const source = (state.sourceTasks as Entity[])[0], sourceId = source?.id ?? ""; const initialRuns = new Set(((state.accessCheckpoint as InternalObservation | undefined)?.runs ?? []).map(run => run.id));
  const reads: SourceReads = { initialLive: false, laterUnavailable: false, laterLive: false };
  for (const run of base.runs.filter(row => row.agentId === base.leadId)) {
    const events = await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
    const found = sourceTaskReads(events, sourceId, source?.identifier);
    if (initialRuns.has(run.id)) reads.initialLive ||= found.live;
    else { reads.laterUnavailable ||= found.unavailable; reads.laterLive ||= found.live; }
  }
  return reads;
}
function cardsObservation(value: unknown): CardsObservation | undefined {
  const o = value as CardsObservation;
  return observation(value) && Array.isArray(o.cards) && !!o.updates && !!o.summaries && typeof o.cardsEnabled === "boolean" ? o : undefined;
}
/** A same-origin link to the author's agent profile, by id or urlKey. */
function authorProfileLinked(o: InternalObservation, author: Entity | undefined) {
  return !!author && o.links.some(href => { try { const url = new URL(href, o.origin); const parts = url.pathname.split("/").map(decodeURIComponent); const index = parts.indexOf("agents");
    return url.origin === new URL(o.origin).origin && index >= 0 && [author.id, author.urlKey].filter(Boolean).includes(parts[index + 1]); } catch { return false; } });
}
function cardLink(o: InternalObservation, id: string) { return resultHref(o, id, "status") ?? resultHref(o, id, "status-cards"); }
/** The company's issue prefix, from its own saved task identifiers. */
function companyPrefix(o: InternalObservation) {
  const prefixes = new Set(o.tasks.map(row => typeof row.identifier === "string" ? row.identifier.replace(/-\d+$/, "") : "").filter(Boolean));
  return prefixes.size === 1 ? [...prefixes][0]! : undefined;
}
/** A same-origin link to this company's status cards page (where archived cards are listed with Restore). */
function statusBoardHref(o: InternalObservation) {
  const prefix = companyPrefix(o); if (!prefix) return undefined;
  return o.links.find(href => { try { const url = new URL(href, o.origin); const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return url.origin === new URL(o.origin).origin && parts.length === 2 && parts[0] === prefix && parts[1] === "status"; } catch { return false; } });
}
const statusBoardLinked = (o: InternalObservation) => !!statusBoardHref(o);
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
    // The card's purpose is the person's words in a model-written interestPrompt, so it is graded through what the
    // summarizer compiled from it: saved queries that are not narrowed to another project, and a product-computed
    // fingerprint that holds the blocked Launch task. Launch is the fixture company's only project, so a company-wide
    // blocked-work query is a valid compile of "the launch's biggest blockers".
    c.add("compiled-launch-watch-scope", !!card && card.queries.length > 0 && card.queries.every(query => !query.projectId || query.projectId === p?.id)
      && originals.some(row => !!card.fingerprint?.[row.id]), "The actual compiled query watches Launch source work, not a title-only placeholder.");
    c.add("inspectable-card-link", !!card && !!cardLink(o, card.id), "The response links the actual saved card.");
    // Whether the reply calls the summary ready is wording and is not pattern-matched. The saved state must show that
    // any summary on the card came from the summarizer's own successful generation, not a write by the requester.
    c.add("configuration-not-false-summary", !!card && (!card.summaryBody || freshSummary(o, card)), "Any summary on the card is the actual successful generation output with its saved revision.");
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
      && !!originals[0] && card.fingerprint?.[originals[0].id]?.title === originals[0].title, "Exactly one refresh creates a new native-backed saved revision using the changed source facts.");
    const initialCard = initial?.cards.find(row => row.id === before?.id);
    // Reply wording is model output and is not pattern-matched (a valid "queued, the card will update" acknowledgement and a
    // reworded result report must both pass). Each turn is graded by what the lead did through the product and linked.
    c.add("initial-refresh-queued-and-linked", !!initial && !!initialCard && !!before && initial.activity.some(event => event.action === "status_card.refresh_requested" && event.agentId === o.leadId && event.entityId === before.id)
      && !!cardLink(initial, before.id), "The first turn queues the refresh as the lead and links the actual card where the person sees the update.");
    const leadRuns = (rows: readonly { id: string; agentId?: string | null }[]) => rows.filter(run => run.agentId === o.leadId).map(run => run.id);
    const initialRunIds = new Set(initial?.runs.map(run => run.id));
    const resultTurn = successfulResult ? leadRuns(successfulResult.runs).filter(id => !initialRunIds.has(id)) : [];
    const finalReply = initial && successfulResult?.reply.startsWith(initial.reply) ? successfulResult.reply.slice(initial.reply.length) : "";
    c.add("actual-result-reported-after-generation", finalReply.trim().length > 0 && turnReadCard(o, resultTurn, [...CARD_STATE_READS, "GET /api/status-cards/{id}/summary-revisions", "GET /api/status-cards/{id}/updates"]),
      "After the summarizer finished, the lead's answer to the later question came from a fresh read of the saved card or its revisions.");
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
    const beforeFailureQuestion = new Set(o.state.failureQuestionRunIds as string[] | undefined);
    const failureTurn = Array.isArray(o.state.failureQuestionRunIds) ? leadRuns(o.runs).filter(id => !beforeFailureQuestion.has(id)) : [];
    c.add("actual-generation-error-reported", failureReply.trim().length > 0 && turnReadCard(o, failureTurn, [...CARD_STATE_READS, "GET /api/status-cards/{id}/updates"]),
      "The failed-attempt question is answered from a fresh read of the card's saved error state or update history, which holds the error and the retained summary.");
  } else if (o.scenarioId === "status-cards.other-authors-card") {
    const morgan = (o.state.worker as Entity | undefined)?.id;
    // Handing the change to the card's author is the owner path the product names
    // ("Agents can manage only cards they authored"): Morgan then changes it under Morgan's own identity.
    const delegated = o.tasks.filter(row => !originals.some(old => old.id === row.id) && row.createdByAgentId === o.leadId && row.assigneeAgentId === morgan);
    const cardWrites = o.activity.filter(event => /^status_card\./.test(event.action ?? "") && event.entityId === card?.id);
    const ownerChanged = delegated.length > 0 && cardWrites.every(event => event.agentId === morgan);
    c.add("morgan-card-not-evaded", !!before && !!card && card.createdByAgentId === morgan && o.cards.length === 1
      && card.interestPrompt === before.interestPrompt && card.archivedAt === before.archivedAt
      && (ownerChanged || JSON.stringify(card.refreshPolicy) === JSON.stringify(before.refreshPolicy) && JSON.stringify(o.summaries[card.id]) === JSON.stringify(o.state.originalSummaries)),
      "Morgan's original card is not archived, cloned or reauthored; it changes only through Morgan's own work on a task the CEO handed to Morgan.");
    // A person reads the reply for meaning; structurally it must route the person to the card,
    // to its author, or to the task handed to the author.
    c.add("author-management-boundary", o.reply.trim().length > 0 && (!!card && !!cardLink(o, card.id) || authorProfileLinked(o, o.state.worker as Entity | undefined)
      || delegated.some(row => hasLink(o, "issues", row)))
      && (delegated.length === 0 || o.runs.every(run => !["queued", "running"].includes(run.status))),
      "The response routes the change to the card, its author or the author's task; a handoff to the author is graded once that work settles.");
    c.add("no-agent-card-mutation", !o.activity.some(event => event.agentId === o.leadId && /^status_card\./.test(event.action ?? "")), "No responding-agent card mutation evades author-specific management.");
  } else c.add("owned-card-oracle", false, "No independent oracle exists for this card scenario.");
  return c.result();
}
async function verifyCard(ctx: ChatCatalogContext, _state: Record<string, unknown>, value: unknown) {
  const o = cardsObservation(value); const card = o && (o.state.card ? o.cards.find(row => row.id === (o.state.card as StatusCard).id) : o.cards[0]); if (!card) throw new Error("Missing saved card");
  const href = cardLink(o!, card.id), board = !href ? statusBoardHref(o!) : undefined;
  if (board) {
    // The reply linked only the board: follow that rendered link to this company's status page.
    const source = ctx.input.page.url(), link = ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(board)}]`).first();
    await expect(link).toBeVisible(); await link.click();
    await expect(ctx.input.page).toHaveURL(url => url.pathname === `/${ctx.input.fixtures.company.issuePrefix}/status`);
    await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  }
  await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/status/${card.id}`, card.title ?? card.interestPrompt, href);
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
/** refresh-card asks four questions, so its lead needs four runs; the shared chat fixture allows three a day. */
export const REFRESH_CARD_LEAD_TURNS = 4;
async function allowLeadTurns(ctx: ChatCatalogContext, turns: number) {
  const leadPath = `/api/agents/${ctx.input.fixtures.agent.id}`;
  const lead = await ctx.input.api.get<{ runtimeConfig: { heartbeat?: Record<string, unknown>; [key: string]: unknown } }>(leadPath);
  await ctx.input.api.patch(leadPath, { runtimeConfig: { ...lead.runtimeConfig, heartbeat: { ...lead.runtimeConfig.heartbeat, maxDailyRuns: turns } } });
  if ((await ctx.input.api.get<typeof lead>(leadPath)).runtimeConfig.heartbeat?.maxDailyRuns !== turns) throw new Error(`Card fixture requires its declared ${turns}-turn daily lead allowance`);
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
      if (id === "status-cards.refresh-card") await allowLeadTurns(ctx, REFRESH_CARD_LEAD_TURNS);
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
        // The Research card asks for blockers, so give it one, as Launch has. With only a backlog task the
        // summarizer searched for blockers that did not exist and its generation ran 171-182s against the 180s limit.
        const research = await project(ctx, "Research");
        sourceTasks.push(await task(ctx, "Lab access blocks research", research.id, { status: "blocked", description: "Research is blocked until the synthetic lab access request is approved." }));
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
  define("status-cards.create-card", "none", { oracleVersion: "paperclip.chat-catalog.status-card.create.v2" }),
  define("status-cards.archive-card", "ceo", { oracleVersion: "paperclip.chat-catalog.status-card.archive.v3", authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-status-card.md"), expectedRunCount: 3, attemptTimeoutMs: 720_000 }),
  define("status-cards.other-authors-card", "morgan", { oracleVersion: "paperclip.chat-catalog.status-card.other-authors.v2", expectedRunCount: 5, minimumRunCount: 2 }),
  define("status-cards.explain-card", "ceo", { oracleVersion: "paperclip.chat-catalog.status-card.explain.v5", authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-status-card.md"), expectedRunCount: 5, minimumRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 720_000,
    sourceFiles: ["chat-catalog-domains/integrator-status-cards.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "run-observations.ts", "chat-scenarios/status-cards.yaml"],
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
    oracleVersion: "paperclip.chat-catalog.status-card.required-work-failure.v7",
    sourceFiles: ["chat-catalog-domains/integrator-status-cards.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/status-card-work-failure.ts", "chat-catalog-domains/external-provider.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/integrator-support.ts", "chat-scenarios/status-cards.yaml"],

    async act(ctx, state) {
      const first = await pollUntil({ label: "initial actual refresh acknowledgement", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => observeCards(ctx, state, { runEvents: false }), accept: o => o.runs.filter(row => row.agentId === o.leadId && row.status === "succeeded").length === 1 && ctx.issue()?.conversationState === "waiting" });
      state.firstRefresh = { ...first, state: structuredClone(state) };
      await ctx.input.evidence("chat-card-refresh-initial-response.json", state.firstRefresh);
      const before = state.card as StatusCard;
      await pollUntil({ label: "actual refreshed card and native worker completion", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => observeCards(ctx, state, { runEvents: false }), accept: o => { const card = o.cards.find(row => row.id === before.id); return !!card && card.lastGeneratedAt !== before.lastGeneratedAt && freshSummary(o, card) && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded"); } });
      const { sendChatMessage } = await import("../chat-flow.js");
      await sendChatMessage(ctx.input.page, "What did the refresh actually produce?", chatCatalogNativePhaseRemainingBudget(ctx));
      const recipe = state.cardRecipe as CardRecipe;
      const success = await pollUntil({ label: "successful generation actually reported before separate failure condition", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: async () => {
          const observed = await observeCards(ctx, state, { runEvents: false });
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
        load: () => observeCards(ctx, state, { runEvents: false }),
        accept: o => {
          const card = o.cards.find(row => row.id === before.id), update = o.updates[before.id]?.find(row => row.id === generation.id);
          const run = o.cardWork?.runs.find(row => row.agentId === recipe.workerId && row.contextSnapshot?.issueId === generation.generationIssueId);
          return !!card && !!update && !!run && card.state === "error" && !card.generatingIssueId && genuineCardWorkFailure(card, update, run.id, o.leadId, o.cardWork);
        },
        reject: o => o.cardWork?.runs.some(run => run.contextSnapshot?.issueId === generation.generationIssueId && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Card generation did not yield a normally completed provider turn; no work-failure substitution" : undefined });
      state.failedGenerationRunId = outcome.cardWork!.runs.find(run => run.agentId === recipe.workerId && run.contextSnapshot?.issueId === generation.generationIssueId)!.id;
      await ctx.input.evidence("chat-card-generation-failure-outcome.json", { ...outcome.cardWork, kind: "synthetic-required-current-source-unavailable", cardId: before.id,
        updateId: generation.id, generationIssueId: generation.generationIssueId, taskOrCardStatusPatched: false, cancelledAsFailure: false, providerFailureSubstituted: false });
      const settled = await pollUntil({ label: "actual refresh source turn settled after failed work", deadlineAt: Date.now() + 180_000, intervalMs: 1000, load: () => observeCards(ctx, state, { runEvents: false }), accept: o => o.runs.length === 6 && o.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      state.failureQuestionRunIds = settled.runs.map(run => run.id);
      await sendChatMessage(ctx.input.page, "What happened to that latest refresh, and which saved summary is available now?", chatCatalogNativePhaseRemainingBudget(ctx));
    },
  }),
];
