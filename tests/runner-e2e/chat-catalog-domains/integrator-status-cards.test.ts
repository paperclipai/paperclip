import { describe, expect, it } from "vitest";
import { cardWorkFixture, successfulCardWorkFixture } from "./status-card-work-failure.test-fixtures.js";
import { gradeIntegratorCards, integratorStatusCardsCases } from "./integrator-status-cards.js";
function valid(id: string) {
  const creation = id === "status-cards.create-card"; const archive = id === "status-cards.archive-card";
  const card = { id: "card", companyId: "company", createdByAgentId: id === "status-cards.other-authors-card" ? "morgan" : "ceo", title: "Launch blockers", interestPrompt: "Launch's biggest blockers", agentId: "morgan", queries: [{ projectId: "project" }], fingerprint: { source: { status: "blocked" } }, refreshPolicy: { mode: "manual" }, archivedAt: archive ? "2026-10-26T12:00:00Z" : null, archivedByAgentId: archive ? "ceo" : null, summaryBody: "Payment approval blocks Launch.", lastGeneratedAt: "2026-10-26T11:00:00Z" };
  const update = { id: "update", kind: "full", status: "ok", runId: "worker-run", generationIssueId: "generation-task" };
  const summary = { id: "summary", body: card.summaryBody };
  const source = { id: "source", companyId: "company", title: "Payment approval blocks launch", status: "blocked" };
  const result = { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" }, worker: { id: "morgan" }, sourceTasks: [structuredClone(source)], ...(creation ? {} : { card: { ...card, archivedAt: null, archivedByAgentId: null }, originalUpdates: [structuredClone(update)], originalSummaries: [structuredClone(summary)], ...(archive ? { otherCard: { ...card, id: "other", interestPrompt: "Research blockers", archivedAt: null, archivedByAgentId: null } } : {}) }) },
    tasks: [source], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: ["/ACORN/status/card"],
    runs: [{ id: "source-run", agentId: "ceo", status: "succeeded" }, { id: "worker-run", agentId: "morgan", status: "succeeded" }],
    activity: creation ? [{ id: "create", action: "status_card.created", entityId: "card", agentId: "ceo" }] : [], cardsEnabled: true, cards: archive ? [card, { ...card, id: "other", interestPrompt: "Research blockers", archivedAt: null, archivedByAgentId: null }] : [card], updates: { card: [update] }, summaries: { card: [summary] },
    reply: creation ? "Created the Launch card; the generated summary is ready." : archive ? "The Launch card is archived. Restore it from archived cards and refresh its older content." : "I cannot manage Morgan's card: only its author or a human operator can change the refresh policy." };
  if (id === "status-cards.explain-card") {
    result.tasks[0]!.status = "done"; result.state.sourceTasks[0]!.status = "done";
    result.reply = "The card reflects its older observation: payment approval blocked Launch. The source task is now done and the payment approval is resolved.";
    result.links.push("/ACORN/issues/source");
    const first = structuredClone(result); Object.assign(result.state, { accessCheckpoint: first, sourceReadStatus: 404, sourceUnavailable: true, accessPrincipalId: "ceo" });
    result.tasks = [];
    result.reply = `${first.reply}\nI can no longer read or verify the current source details; the task is unavailable. The older saved card is historical context only.`;
  }
  if (id === "status-cards.refresh-card") {
    const first = structuredClone(result); first.reply = "The refresh was requested; generation is pending.";
    Object.assign(result.state, { firstRefresh: first });
    result.cards[0]!.summaryBody = "The remaining blocker is mobile Safari checkout.";
    result.cards[0]!.lastGeneratedAt = "2026-10-26T12:00:00Z";
    result.updates.card.push({ ...update, id: "new-update", runId: "new-worker-run", generationIssueId: "refresh-task" });
    result.summaries.card.push({ id: "new-summary", body: result.cards[0]!.summaryBody });
    result.runs.push({ id: "new-worker-run", agentId: "morgan", status: "succeeded" });
    result.reply = `${first.reply}\nThe refreshed summary identifies mobile Safari checkout as the remaining blocker.`;
    const successful = structuredClone(result);
    const work = cardWorkFixture();
    const initialChecklist = successfulCardWorkFixture("worker-run", "generation-task", "update");
    const successfulChecklist = successfulCardWorkFixture("new-worker-run", "refresh-task", "new-update");
    Object.assign(result.state, { successfulRefreshResult: successful, failedGenerationRunId: "failed-native", failedGenerationIssueId: "failure-task", cardRecipe: work.evidence.recipe, initialChecklist: initialChecklist.evidence, successfulChecklist: successfulChecklist.evidence });
    Object.assign(result.cards[0]!, work.card);
    Object.assign(result.updates.card[0]!, initialChecklist.update); Object.assign(result.updates.card[1]!, successfulChecklist.update);
    Object.assign((result.state as Record<string, unknown>).originalUpdates as object[], [initialChecklist.update]);
    result.updates.card.push(work.update as unknown as typeof update);
    Object.assign(result, { cardWork: work.evidence, runs: work.evidence.runs });
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
  it("rejects deletion instead of archive, lost historical summary, and false restore claims", () => {
    const o = valid("status-cards.archive-card");
    expect(gradeIntegratorCards({ ...o, cards: [] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, summaries: { card: [] } }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, reply: "The card was permanently removed, not archived. Restore and refresh it." }).passed).toBe(false);
    const altered = structuredClone(o); altered.tasks[0]!.status = "done";
    expect(gradeIntegratorCards(altered).passed).toBe(false);
  });
  it("rejects author evasion, stealth cloning, and refused-but-hourly false success", () => {
    const o = valid("status-cards.other-authors-card");
    expect(gradeIntegratorCards({ ...o, cards: [...o.cards, { ...o.cards[0]!, id: "copy", createdByAgentId: "ceo" }] }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, reply: "Only Morgan owns this card, but I updated it to every hour. A human can inspect it." }).passed).toBe(false);
    const stolen = structuredClone(o); stolen.cards[0]!.createdByAgentId = "ceo";
    expect(gradeIntegratorCards(stolen).passed).toBe(false);
  });
  it("rejects an older blocker presented as current and missing source grounding", () => {
    const o = valid("status-cards.explain-card");
    expect(gradeIntegratorCards({ ...o, reply: "The card is current and up-to-date. Payment approval still blocks Launch although the task is done." }).passed).toBe(false);
    expect(gradeIntegratorCards({ ...o, links: ["/ACORN/status/card"] }).passed).toBe(false);
    const falseCurrent = structuredClone(o); falseCurrent.reply += " I verified the current restricted task."; expect(gradeIntegratorCards(falseCurrent).passed).toBe(false);
    const unrelated = structuredClone(o); Object.assign(unrelated.state, { accessPrincipalId: "someone-else" }); expect(gradeIntegratorCards(unrelated).passed).toBe(false);
    const fabricated = structuredClone(o); fabricated.cards[0]!.lastGeneratedAt = "2026-10-26T12:00:00Z";
    expect(gradeIntegratorCards(fabricated).passed).toBe(false);
  });
  it("rejects stale acknowledgement described as fresh, duplicate refresh and no later result", () => {
    const o = valid("status-cards.refresh-card");
    const first = (o.state as Record<string, unknown>).firstRefresh as ReturnType<typeof valid>;
    const dishonest = structuredClone(o); ((dishonest.state as Record<string, unknown>).firstRefresh as ReturnType<typeof valid>).reply = "The card is updated and ready with a fresh summary.";
    expect(gradeIntegratorCards(dishonest).passed).toBe(false);
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
    expect(gradeIntegratorCards({ ...o, reply: o.reply + " A new summary is ready; refresh succeeded." }).passed).toBe(false);
    const checkpoint = (o.state as Record<string, unknown>).successfulRefreshResult as ReturnType<typeof valid>;
    expect(gradeIntegratorCards({ ...o, reply: checkpoint.reply + " The refresh could not finish. The last good output was kept unchanged." }).passed).toBe(true);
  });
});

import { explainsSavedStaleness } from "./integrator-status-cards.js";
it("accepts natural saved-wording/live-status distinction without requiring the literal word card", () => {
  expect(explainsSavedStaleness("It's stale wording, not a current blocker. RUN-1 is done and says the payment approval was received.")).toBe(true);
  expect(explainsSavedStaleness("The wording is not stale. Payment approval is completed.")).toBe(false);
  expect(explainsSavedStaleness("The summary is fresh. Payment approval is resolved.")).toBe(false);
  expect(explainsSavedStaleness("The older summary is stale, but Launch is still blocked. Payment approval is completed.")).toBe(false);
});
it("a paraphrase cannot replace required saved-card link or source-access evidence", () => {
  const o = valid("status-cards.explain-card"); const first = (o.state as Record<string, unknown>).accessCheckpoint as ReturnType<typeof valid>;
  first.reply = "It's stale wording, not a current blocker. The source task is done and the payment approval was received.";
  o.reply = first.reply + "\nI can no longer read or verify its current state; only the older saved summary remains.";
  expect(gradeIntegratorCards(o).passed).toBe(true);
  expect(gradeIntegratorCards({ ...o, links: ["/ACORN/issues/source"] }).passed).toBe(false);
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
it("declares factual human attachments only for the two actual missing selected referents", () => {
  for (const id of ["status-cards.explain-card", "status-cards.archive-card"]) {
    const definition = integratorStatusCardsCases.find(row => row.scenarioId === id)!;
    expect(definition.authentication).toBe("human-session"); expect(definition.queryAttachments).toEqual([{ stateKey: "factualContextAttachment", filename: "selected-status-card.md" }]);
  }
  // The refresh query already names Launch and the retained run selected it correctly.
  expect(integratorStatusCardsCases.find(row => row.scenarioId === "status-cards.refresh-card")!.queryAttachments).toBeUndefined();
});
