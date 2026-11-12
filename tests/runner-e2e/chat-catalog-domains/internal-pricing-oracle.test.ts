import { expect, it } from "vitest";
import { grade_documents_artifacts, monthlyTeamPricing } from "./internal-documents-artifacts.js";

it.each([
  "$19 monthly total for the entire team, not per user.",
  "$19 monthly total for the entire team, not $19 per user.",
  "$19 monthly total for the entire team, not a per-user charge.",
  "$19 per month for the whole team. It is not billed per person.",
  "The monthly total is $19 per team; no per-seat charge.",
  "$19 monthly total for the team, not $49. Per user pricing is incorrect.",
])("accepts correct team pricing and scoped negation of the original ambiguity: %s", body => {
  expect(monthlyTeamPricing(body)).toBe(true);
});
it.each([
  "$19 monthly total for the team. Each user also pays $19.",
  "$19 monthly total for the team, but $19 per user too.",
  "$190 monthly total for the entire team, not per user.",
  "Not $19 monthly total for the team; $49 instead.",
  "$19 yearly total for the team. Monthly support is available.",
  "$19 monthly per user.",
  "$19 monthly total, not for the entire team.",
  "The personal subscription costs $19. Monthly support is available for the entire team in total.",
  "Monthly total for the entire team, not per user.",
  "$19 monthly total, not for the team, but per user.",
])("rejects missing pricing, wrong amount/cadence or an actual per-person charge: %s", body => {
  expect(monthlyTeamPricing(body)).toBe(false);
});
it("preserves unrelated content, exact annotation relationships, saved revision and edit-before-resolution proof", () => {
  const task = { id: "task", companyId: "company", title: "Website task", status: "backlog", projectId: "project" };
  const supportText = "Support is provided by the original launch team fixture-42.";
  const body = `$19 monthly total for the entire team, not per user.\n\n${supportText}`;
  const o = { scenarioId: "documents-artifacts.resolve-feedback", companyId: "company", origin: "https://fixture.test", leadId: "ceo",
    state: { task, pricingThread: { id: "pricing" }, siblingThread: { id: "sibling" }, supportText, originalRevisionId: "original" }, tasks: [task], projects: [], goals: [], comments: [],
    documents: [{ id: "document", key: "plan", latestRevisionId: "revision", body }], revisions: [{ id: "revision", body, createdByAgentId: "ceo" }],
    annotations: [{ id: "pricing", status: "resolved", resolvedByAgentId: "ceo", documentId: "document", originalRevisionId: "original" }, { id: "sibling", status: "open" }],
    activity: [{ id: "edit", action: "issue.document_updated", agentId: "ceo", createdAt: "2026-10-27T10:00:00Z" },
      { id: "resolve", action: "issue.document_annotation_thread_resolved", agentId: "ceo", details: { threadId: "pricing" }, createdAt: "2026-10-27T10:00:01Z" }],
    reply: "Updated the pricing and resolved its review comment.", links: ["/RUN/issues/task"], humanQueries: [], runs: [] };
  expect(grade_documents_artifacts(o).passed).toBe(true);
  expect(grade_documents_artifacts({ ...o, documents: [{ ...o.documents[0], body: "$19 monthly total for the entire team, not per user." }] }).passed).toBe(false);
  expect(grade_documents_artifacts({ ...o, annotations: o.annotations.map(row => ({ ...row, status: "resolved" })) }).passed).toBe(false);
  expect(grade_documents_artifacts({ ...o, activity: [o.activity[1], { ...o.activity[0], createdAt: "2026-10-27T10:00:02Z" }] }).passed).toBe(false);
});
