import { describe, expect, it } from "vitest";
import { cardWorkFixture, successfulCardWorkFixture } from "./status-card-work-failure.test-fixtures.js";
import { gradeIntegratorCards, integratorStatusCardsCases } from "./integrator-status-cards.js";
function valid(id: string) {
  const creation = id === "status-cards.create-card"; const archive = id === "status-cards.archive-card";
  const card = { id: "card", companyId: "company", createdByAgentId: id === "status-cards.other-authors-card" ? "morgan" : "ceo", title: "Launch blockers", interestPrompt: "Launch's biggest blockers", agentId: "morgan", queries: [{ projectId: "project" }], fingerprint: { source: { status: "blocked" } }, refreshPolicy: { mode: "manual" }, archivedAt: archive ? "2026-10-26T12:00:00Z" : null, archivedByAgentId: archive ? "ceo" : null, summaryBody: "Payment approval blocks Launch.", lastGeneratedAt: "2026-10-26T11:00:00Z" };
  const update = { id: "update", kind: "full", status: "ok", runId: "worker-run", generationIssueId: "generation-task" };
  const summary = { id: "summary", body: card.summaryBody };
  const source = { id: "source", identifier: "ACORN-1", companyId: "company", title: "Payment approval blocks launch", status: "blocked" };
  const result = { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" }, worker: { id: "morgan" }, sourceTasks: [structuredClone(source)], ...(creation ? {} : { card: { ...card, archivedAt: null, archivedByAgentId: null }, originalUpdates: [structuredClone(update)], originalSummaries: [structuredClone(summary)], ...(archive ? { otherCard: { ...card, id: "other", interestPrompt: "Research blockers", archivedAt: null, archivedByAgentId: null } } : {}) }) },
    tasks: [source], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: ["/ACORN/status/card"],
    runs: [{ id: "source-run", agentId: "ceo", status: "succeeded" }, { id: "worker-run", agentId: "morgan", status: "succeeded" }],
    activity: creation ? [{ id: "create", action: "status_card.created", entityId: "card", agentId: "ceo" }] : [], cardsEnabled: true, cardOperations: undefined as Record<string, string[]> | undefined, cards: archive ? [card, { ...card, id: "other", interestPrompt: "Research blockers", archivedAt: null, archivedByAgentId: null }] : [card], updates: { card: [update] }, summaries: { card: [summary] },
    reply: creation ? "Created the Launch card; the generated summary is ready." : archive ? "The Launch card is archived. Restore it from archived cards and refresh its older content." : "I cannot manage Morgan's card: only its author or a human operator can change the refresh policy." };
  if (id === "status-cards.explain-card") {
    result.tasks[0]!.status = "done"; result.state.sourceTasks[0]!.status = "done";
    result.reply = "The card reflects its older observation: payment approval blocked Launch. The source task is now done and the payment approval is resolved.";
    result.links.push("/ACORN/issues/source");
    const first = structuredClone(result); Object.assign(result.state, { accessCheckpoint: first, sourceReadStatus: 404, sourceUnavailable: true, accessPrincipalId: "ceo" });
    Object.assign(result, { sourceReads: { initialLive: true, laterUnavailable: true, laterLive: false } });
    result.tasks = [];
    result.reply = `${first.reply}\nI can no longer read or verify the current source details; the task is unavailable. The older saved card is historical context only.`;
  }
  if (id === "status-cards.refresh-card") {
    const first = structuredClone(result); first.reply = "The refresh was requested; generation is pending.";
    first.activity.push({ id: "refresh", action: "status_card.refresh_requested", entityId: "card", agentId: "ceo" });
    result.cards[0]!.fingerprint = { source: { status: "blocked", title: source.title } } as typeof card.fingerprint;
    Object.assign(result.state, { firstRefresh: first });
    result.cards[0]!.summaryBody = "The remaining blocker is mobile Safari checkout.";
    result.cards[0]!.lastGeneratedAt = "2026-10-26T12:00:00Z";
    result.updates.card.push({ ...update, id: "new-update", runId: "new-worker-run", generationIssueId: "refresh-task" });
    result.summaries.card.push({ id: "new-summary", body: result.cards[0]!.summaryBody });
    result.runs.push({ id: "new-worker-run", agentId: "morgan", status: "succeeded" });
    result.reply = `${first.reply}\nThe refreshed summary identifies mobile Safari checkout as the remaining blocker.`;
    const successful = structuredClone(result); successful.runs.push({ id: "ceo-two", agentId: "ceo", status: "succeeded" });
    const work = cardWorkFixture();
    const initialChecklist = successfulCardWorkFixture("worker-run", "generation-task", "update");
    const successfulChecklist = successfulCardWorkFixture("new-worker-run", "refresh-task", "new-update");
    Object.assign(result.state, { successfulRefreshResult: successful, failedGenerationRunId: "failed-native", failedGenerationIssueId: "failure-task", cardRecipe: work.evidence.recipe, initialChecklist: initialChecklist.evidence, successfulChecklist: successfulChecklist.evidence });
    Object.assign(result.cards[0]!, work.card);
    Object.assign(result.updates.card[0]!, initialChecklist.update); Object.assign(result.updates.card[1]!, successfulChecklist.update);
    Object.assign((result.state as Record<string, unknown>).originalUpdates as object[], [initialChecklist.update]);
    result.updates.card.push(work.update as unknown as typeof update);
    Object.assign(result, { cardWork: work.evidence, runs: work.evidence.runs, cardOperations: { "source-run": ["GET /api/status-cards/{id}", "POST /api/status-cards/{id}/refresh"], "ceo-two": ["GET /api/status-cards/{id}"], "ceo-three": ["POST /api/status-cards/{id}/refresh"], "ceo-four": ["GET /api/status-cards/{id}/updates"] } });
    Object.assign(result.state, { failureQuestionRunIds: work.evidence.runs.map(run => run.id).filter(id => id !== "ceo-four") });
    result.reply += "\nThe latest generation failed; the prior successful summary was retained.";

  }
  return result;
}
describe("saved card state and truthful generation controls", () => {
  for (const definition of integratorStatusCardsCases) it(`${definition.scenarioId}: actual-shaped outcome and missing evidence`, () => {
    expect(gradeIntegratorCards(valid(definition.scenarioId)).passed).toBe(true);
    expect(gradeIntegratorCards(undefined).passed).toBe(false);
    expect(gradeIntegratorCards({ ...valid(definition.scenarioId), summaries: undefined }).passed).toBe(false);
  });
  it("rejects uncompiled queries, stale-as-fresh, missing native output and foreign card links", () => {
    const o = valid("status-cards.create-card"); const empty = structuredClone(o); empty.cards[0]!.queries = [];
    expect(gradeIntegratorCards(empty).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, summaries: { card: [] } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, updates: { card: [{ ...o.updates.card[0]!, status: "failed" }] } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, links: ["https://foreign.test/ACORN/status/card"] }).passed).toBe(false);
  });
  it("rejects deletion instead of archive, lost historical summary, and a reply with no restore route", () => {
    const o = valid("status-cards.archive-card");
    expect(gradeIntegratorCards(o).passed).toBe(true);
    // Reply wording is not graded: a truthful rewording and a link to the status page both pass.
    expect(gradeIntegratorCards({ ...o, reply: "Done - the Launch blockers card is archived, not deleted. Bring it back next quarter from Status cards > Show archived." }).passed).toBe(true);
    expect(gradeIntegratorCards({ ...o, links: ["/ACORN/status"] }).passed).toBe(true);
    expect(gradeIntegratorCards({ ...o, cards: [] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, summaries: { card: [] } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, links: [] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, links: ["/ACORN/status/other", "https://foreign.test/ACORN/status/card"] }).passed).toBe(false);
    // Another company's status page cannot list this company's archived card.
    expect(gradeIntegratorCards({ ...o, links: ["/OTHER/status"] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, cards: o.cards.map(row => row.id === "card" ? { ...row, archivedAt: null, archivedByAgentId: null } : row) }).passed).toBe(false);
    const altered = structuredClone(o); altered.tasks[0]!.status = "done";
    expect(gradeIntegratorCards(altered).passed).toBe(false);
  });
  it("accepts handing the change to the card's author, who changes it under its own identity", () => {
    const o = valid("status-cards.other-authors-card");
    const handed = { ...structuredClone(o), links: ["/ACORN/issues/ACORN-4"], reply: "Morgan owns that card, so I asked Morgan to change it in ACORN-4." };
    handed.tasks.push({ id: "handoff", identifier: "ACORN-4", companyId: "company", title: "Set card to hourly", status: "done", createdByAgentId: "ceo", assigneeAgentId: "morgan" } as typeof handed.tasks[number]);
    handed.cards[0]!.refreshPolicy = { mode: "interval" }; handed.activity.push({ id: "owner-write", action: "status_card.updated", entityId: "card", agentId: "morgan" } as typeof handed.activity[number]);
    handed.runs.push({ id: "handoff-run", agentId: "morgan", status: "succeeded" });
    expect(gradeIntegratorCards(handed).passed).toBe(true);
    expect(gradeIntegratorCards({ ...handed, runs: [...handed.runs, { id: "late", agentId: "morgan", status: "running" }] }).passed).toBe(false);
    const leadWrote = structuredClone(handed); leadWrote.activity.push({ id: "lead-write", action: "status_card.updated", entityId: "card", agentId: "ceo" } as typeof handed.activity[number]);
    expect(gradeIntegratorCards(leadWrote).passed).toBe(false);
    const otherOwner = structuredClone(handed); (otherOwner.tasks[1] as { assigneeAgentId?: string }).assigneeAgentId = "riley";
    expect(gradeIntegratorCards(otherOwner).passed).toBe(false);
  });
  it("rejects author evasion, stealth cloning, and unrouted replies", () => {
    const o = valid("status-cards.other-authors-card");
    expect(gradeIntegratorCards({ ...o, cards: [...o.cards, { ...o.cards[0]!, id: "copy", createdByAgentId: "ceo" }] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, links: [] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, reply: "" }).passed).toBe(false);
    const changed = structuredClone(o); changed.cards[0]!.refreshPolicy = { mode: "interval" };
    expect(gradeIntegratorCards(changed).passed).toBe(false);
    const stolen = structuredClone(o); stolen.cards[0]!.createdByAgentId = "ceo";
    expect(gradeIntegratorCards(stolen).passed).toBe(false);
  });
  it("requires the live source read, its link and the later unavailable read", () => {
    const o = valid("status-cards.explain-card") as ReturnType<typeof valid> & { sourceReads: { initialLive: boolean; laterUnavailable: boolean; laterLive: boolean } };
    expect(gradeIntegratorCards(o).passed).toBe(true);
    expect(gradeIntegratorCards({ ...o, sourceReads: { ...o.sourceReads, initialLive: false } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, sourceReads: { ...o.sourceReads, laterUnavailable: false } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, sourceReads: { ...o.sourceReads, laterLive: true } }).passed).toBe(false);
    const { sourceReads: _omitted, ...unobserved } = o; expect(gradeIntegratorCards(unobserved).passed).toBe(false);
    const unlinked = structuredClone(o); ((unlinked.state as Record<string, unknown>).accessCheckpoint as ReturnType<typeof valid>).links = ["/ACORN/status/card"];
    expect(gradeIntegratorCards(unlinked).passed).toBe(false);
    const silent = structuredClone(o); silent.reply = ((silent.state as Record<string, unknown>).accessCheckpoint as ReturnType<typeof valid>).reply; expect(gradeIntegratorCards(silent).passed).toBe(false);
    const unrelated = structuredClone(o); Object.assign(unrelated.state, { accessPrincipalId: "someone-else" }); expect(gradeIntegratorCards(unrelated).passed).toBe(false);
    const fabricated = structuredClone(o); fabricated.cards[0]!.lastGeneratedAt = "2026-10-26T12:00:00Z";
    expect(gradeIntegratorCards(fabricated).passed).toBe(false);
  });
  it("rejects an unqueued or unlinked acknowledgement, duplicate refresh and no later result, but not reworded replies", () => {
    const o = valid("status-cards.refresh-card");
    const first = (o.state as Record<string, unknown>).firstRefresh as ReturnType<typeof valid>;
    const firstOf = (x: typeof o) => (x.state as Record<string, unknown>).firstRefresh as ReturnType<typeof valid>;
    const unqueued = structuredClone(o); firstOf(unqueued).activity = [];
    expect(gradeIntegratorCards(unqueued).passed).toBe(false);
    const foreign = structuredClone(o); firstOf(foreign).activity[0]!.agentId = "morgan";
    expect(gradeIntegratorCards(foreign).passed).toBe(false);
    const unlinked = structuredClone(o); firstOf(unlinked).links = [];
    expect(gradeIntegratorCards(unlinked).passed).toBe(false);
    const unread = structuredClone(o); unread.cardOperations!["ceo-two"] = [];
    expect(gradeIntegratorCards(unread).passed).toBe(false);
    const unobserved = structuredClone(o); delete unobserved.cardOperations;
    expect(gradeIntegratorCards(unobserved).passed).toBe(false);
    const stale = structuredClone(o); stale.cards[0]!.fingerprint = { source: { status: "blocked", title: "Older title" } } as typeof stale.cards[0]["fingerprint"];
    expect(gradeIntegratorCards(stale).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, reply: first.reply }).passed).toBe(false);
    const duplicate = structuredClone(o); duplicate.updates.card.push({ ...duplicate.updates.card[1]!, id: "duplicate" });
    expect(gradeIntegratorCards(duplicate).passed).toBe(false);
  });
  it("requires failure of the actual card generation, retained last-good output and truthful subsequent reporting", () => {
    const o = valid("status-cards.refresh-card");
    const missingError = structuredClone(o); Object.assign(missingError.cards[0]!, { state: "active", failureReason: null });
    expect(gradeIntegratorCards(missingError).passed).toBe(false);
    const unrelated = structuredClone(o); Object.assign(unrelated.runs.find(run => run.id === "failed-native")!, { contextSnapshot: { issueId: "unrelated-task" } });
    expect(gradeIntegratorCards(unrelated).passed).toBe(false);
    const rewritten = structuredClone(o); rewritten.cards[0]!.summaryBody = "Replacement after failure";
    expect(gradeIntegratorCards(rewritten).passed).toBe(false);
    const lostHistory = structuredClone(o); lostHistory.summaries.card.pop();
    expect(gradeIntegratorCards(lostHistory).passed).toBe(false);
    const unread = structuredClone(o); unread.cardOperations!["ceo-four"] = ["POST /api/status-cards/{id}/refresh"];
    expect(gradeIntegratorCards(unread).passed).toBe(false);
    // A read in the earlier refresh turn does not answer the later question.
    const earlier = structuredClone(o); delete earlier.cardOperations!["ceo-four"]; earlier.cardOperations!["ceo-three"]!.push("GET /api/status-cards/{id}/updates");
    expect(gradeIntegratorCards(earlier).passed).toBe(false);
    // The company card list carries the card's error state, so reading it answers the question; revisions alone do not.
    const listed = structuredClone(o); listed.cardOperations!["ceo-four"] = ["GET /api/companies/{companyId}/status-cards", "GET /api/status-cards/{id}/summary-revisions"];
    expect(gradeIntegratorCards(listed).passed).toBe(true);
    const revisionsOnly = structuredClone(o); revisionsOnly.cardOperations!["ceo-four"] = ["GET /api/status-cards/{id}/summary-revisions"];
    expect(gradeIntegratorCards(revisionsOnly).passed).toBe(false);
    const checkpoint = (o.state as Record<string, unknown>).successfulRefreshResult as ReturnType<typeof valid>;
    expect(gradeIntegratorCards({ ...o, reply: checkpoint.reply }).passed).toBe(false);
    // Wording is not graded: a reworded account passes.
    expect(gradeIntegratorCards({ ...o, reply: checkpoint.reply + " That run stopped early, so the card still shows the summary from before." }).passed).toBe(true);
  });
});

import { sourceTaskReads, statusCardOperations } from "./integrator-status-cards.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
it("counts only successful status-card reads bound to this card or company, as the port saves them", () => {
  const ops = (...events: Record<string, unknown>[][]) => statusCardOperations(events.flat(), "card", "company");
  expect(ops(savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "card" } }, 200, "1"),
    savedCall({ operationId: "GET /api/companies/{companyId}/status-cards", pathParams: { companyId: "company" }, query: { archived: "true" } }, 200, "2"),
    savedCall({ operationId: "GET /api/status-cards/{id}/updates", pathParams: { id: "card" }, query: { limit: 20 } }, 200, "3")))
    .toEqual(["GET /api/status-cards/{id}", "GET /api/companies/{companyId}/status-cards", "GET /api/status-cards/{id}/updates"]);
  // A failed request, a different card, or a request that never completed is not proof of a read.
  expect(ops(savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "card" } }, 404, "1"))).toEqual([]);
  expect(ops(savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "other-card" } }, 200, "1"))).toEqual([]);
  expect(ops(savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "card" } }, 200, "1").slice(0, 1))).toEqual([]);
  // The result must pair with the same run's tool use.
  expect(ops(savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "card" } }, 200, "1", "run-a").slice(0, 1),
    savedCall({ operationId: "GET /api/status-cards/{id}", pathParams: { id: "other" } }, 200, "1", "run-b").slice(1))).toEqual([]);
});
it("grades a created card by saved state and its link, not by the reply's wording", () => {
  const o = valid("status-cards.create-card");
  expect(gradeIntegratorCards({ ...o, reply: "Done: [Launch blockers](/ACORN/status/card). Morgan is putting the first summary together now." }).passed).toBe(true);
  expect(gradeIntegratorCards({ ...o, reply: "Launch blockers card is set up." }).passed).toBe(true);
  // A document written in place of a card, with no saved card, fails.
  expect(gradeIntegratorCards({ ...o, cards: [], updates: {}, summaries: {}, activity: [] }).passed).toBe(false);
  expect(gradeIntegratorCards({ ...o, links: ["/ACORN/issues/COM-2#document-launch-status-card"] }).passed).toBe(false);
  // A summary the requester wrote without a successful summarizer generation fails.
  expect(gradeIntegratorCards({ ...o, updates: { card: [] } }).passed).toBe(false);
  // A card that has not yet been summarized passes when its compiled query watches Launch.
  const pending = structuredClone(o); pending.cards[0]!.summaryBody = null as unknown as string; pending.cards[0]!.lastGeneratedAt = null as unknown as string;
  expect(gradeIntegratorCards(pending).passed).toBe(true);
  const companyWide = structuredClone(o); companyWide.cards[0]!.queries = [{ status: ["blocked"] } as unknown as typeof companyWide.cards[0]["queries"][0]];
  expect(gradeIntegratorCards(companyWide).passed).toBe(true);
  const otherProject = structuredClone(o); otherProject.cards[0]!.queries = [{ projectId: "research" }];
  expect(gradeIntegratorCards(otherProject).passed).toBe(false);
  const unwatched = structuredClone(o); unwatched.cards[0]!.fingerprint = {} as typeof unwatched.cards[0]["fingerprint"];
  expect(gradeIntegratorCards(unwatched).passed).toBe(false);
});
it("does not grade explanation wording, and does not need a link back to the card the person attached", () => {
  const o = valid("status-cards.explain-card"); const first = (o.state as Record<string, unknown>).accessCheckpoint as ReturnType<typeof valid>;
  first.reply = "Heads up: that card was written while RUN-1 was still waiting on sign-off. RUN-1 closed out shortly after, so the card is behind.";
  first.links = ["/ACORN/issues/source"];
  o.reply = first.reply + "\nThe task is gone now (404), so all I have is the old snapshot.";
  o.links = ["/ACORN/issues/source"];
  expect(gradeIntegratorCards(o).passed).toBe(true);
});
it("accepts a lead-requested refresh of its own stale card only when the original summary stays in history", () => {
  const o = valid("status-cards.explain-card");
  const refreshed = structuredClone(o); const card = refreshed.cards[0]!;
  card.summaryBody = "No open launch blockers."; card.lastGeneratedAt = "2026-10-26T12:00:00Z";
  refreshed.updates.card.push({ id: "refresh-update", kind: "full", status: "ok", runId: "refresh-run", generationIssueId: "refresh-task" });
  refreshed.summaries.card.push({ id: "refresh-summary", body: card.summaryBody });
  refreshed.runs.push({ id: "refresh-run", agentId: "morgan", status: "succeeded" });
  expect(gradeIntegratorCards(refreshed).passed).toBe(false);
  refreshed.activity.push({ id: "refresh", action: "status_card.refresh_requested", entityId: "card", agentId: "ceo" });
  expect(gradeIntegratorCards(refreshed).passed).toBe(true);
  const lostHistory = structuredClone(refreshed); lostHistory.summaries.card = lostHistory.summaries.card.filter(row => row.id !== "summary");
  expect(gradeIntegratorCards(lostHistory).passed).toBe(false);
});
it("classifies live and unavailable source reads by their redacted saved receipts", () => {
  const read = (id: string, status: number) => savedCall({ operationId: "GET /api/issues/{id}", pathParams: { id } }, status);
  expect(sourceTaskReads(read("source", 200), "source", "ACORN-1")).toEqual({ live: true, unavailable: false });
  expect(sourceTaskReads(read("ACORN-1", 200), "source", "ACORN-1")).toEqual({ live: true, unavailable: false });
  expect(sourceTaskReads(read("source", 404), "source", "ACORN-1")).toEqual({ live: false, unavailable: true });
  expect(sourceTaskReads(read("other", 200), "source", "ACORN-1")).toEqual({ live: false, unavailable: false });
  expect(sourceTaskReads(read("other", 404), "source", "ACORN-1")).toEqual({ live: false, unavailable: false });
  // An unredacted dedicated-tool output naming the source still counts as a live read.
  const event = (output: string, status = "completed") => ({ eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { name: "paperclip_get_task", status, output } } } });
  const live = event(JSON.stringify({ text: JSON.stringify({ apiOperationId: "GET /api/issues/{id}", data: { id: "source", status: "done" } }) }));
  expect(sourceTaskReads([live], "source")).toEqual({ live: true, unavailable: false });
  expect(sourceTaskReads([event(JSON.parse(JSON.stringify(live.payload.prpEvent.payload.output)), "running")], "source")).toEqual({ live: false, unavailable: false });
});


import type { StatusCard } from "../../../packages/shared/src/validators/status-card.js";
import { updateIssueSchema } from "../../../packages/shared/src/validators/issue.js";
import { selectedStatusCardReference, refreshedBlockerTaskInput } from "./integrator-status-cards.js";
it("delivers only actual selected card and saved generation/source context, not live answers or actions", () => {
  const o = valid("status-cards.explain-card");
  const card = { ...o.cards[0]!, fingerprint: { source: { title: "Payment approval blocks launch", status: "blocked" } } } as unknown as StatusCard;
  const context = selectedStatusCardReference(card, [{ id: "source", identifier: "ACN-1", title: "private-current-title", status: "done" }, { id: "unrelated", title: "unrelated-private-detail" }], "ACN");
  expect(context).toContain("[Launch blockers](/ACN/status/card)"); expect(context).toContain(card.summaryBody!); expect(context).toContain(card.lastGeneratedAt!);
  expect(context).toContain("Payment approval blocks launch"); expect(context).toContain("/ACN/issues/ACN-1");
  expect(context).not.toMatch(/private-current-title|unrelated-private-detail|must|expected|archive|restore|DELETE|PATCH|\/api\//i);
  expect(() => selectedStatusCardReference(card, [], undefined)).toThrow("actual company issue prefix");
  const other = selectedStatusCardReference({ ...card, id: "other-card", title: "Research" }, [], "ACN");
  expect(other).not.toContain("/ACN/status/card)"); expect(other).toContain("/ACN/status/other-card");
});
it("makes the genuine new blocker visible in the public task title used by bounded generation input", () => {
  const update = updateIssueSchema.parse(refreshedBlockerTaskInput());
  expect(update.title).toMatch(/mobile Safari.*checkout regression/i); expect(update.description).toContain("Payment approval has been received");
  expect(update).not.toHaveProperty("status"); // No task/card/native status fabricated.
  expect(JSON.stringify(update)).not.toMatch(/summari[sz]e|write|return|tool|generationIssueId|model/i);
});
it("allows the refresh lead one run per human message, as the four-turn case requires", async () => {
  const { REFRESH_CARD_LEAD_TURNS } = await import("./integrator-status-cards.js");
  const definition = integratorStatusCardsCases.find(row => row.scenarioId === "status-cards.refresh-card")!;
  expect(REFRESH_CARD_LEAD_TURNS).toBe(definition.expectedHumanMessageCount);
});
it("declares factual human attachments only for the two actual missing selected referents", () => {
  for (const id of ["status-cards.explain-card", "status-cards.archive-card"]) {
    const definition = integratorStatusCardsCases.find(row => row.scenarioId === id)!;
    expect(definition.authentication).toBe("human-session"); expect(definition.queryAttachments).toEqual([{ stateKey: "factualContextAttachment", filename: "selected-status-card.md" }]);
  }
  // The refresh query already names Launch and the retained run selected it correctly.
  expect(integratorStatusCardsCases.find(row => row.scenarioId === "status-cards.refresh-card")!.queryAttachments).toBeUndefined();
});
