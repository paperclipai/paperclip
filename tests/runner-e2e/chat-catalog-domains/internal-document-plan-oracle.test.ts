import { expect, it } from "vitest";
import { grade_documents_artifacts, meaningfulOrchidPlan } from "./internal-documents-artifacts.js";

it.each([
  "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup and do not add unrelated registration flows. Verify keyboard navigation and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout. The team must not sacrifice accuracy. A previous unrelated site did not support mobile devices.",
  "Develop one accessible web page for Orchid registration, using responsive breakpoints. Test keyboard navigation and mobile presentation.",
  "Build an accessible single-page Orchid signup website with responsive layout. Verify keyboard navigation and mobile layout; never sacrifice accuracy for brevity.",
  "Implement a single responsive page for Orchid with accessible signup. Do not build multiple pages. Verify keyboard navigation and mobile layout.",
])("accepts substantive plan requirements despite word order and unrelated negation: %s", body => {
  expect(meaningfulOrchidPlan(body)).toBe(true);
});
it.each([
  "Implement Birch in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup. Verify mobile layout.",
  "Implement Orchid in a single page with accessible signup. Verify keyboard navigation and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout. Build multiple pages instead.",
  "Do not implement a single responsive page for Orchid with accessible signup. Develop multiple pages. Verify keyboard navigation and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout. Never ever include mobile support.",
  "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout. The website must not support mobile devices.",
  "Implement Orchid in a single responsive page without signup. Verify keyboard navigation, accessibility and mobile layout.",
  "Implement Orchid in a single responsive page with accessible signup. No need to test keyboard or mobile layout.",
])("rejects missing, foreign or contradictory requirements: %s", body => {
  expect(meaningfulOrchidPlan(body)).toBe(false);
});

it("retains real task, saved revision and run-attributed creation requirements", () => {
  const task = { id: "task", companyId: "company", title: "Website task", status: "backlog", projectId: "project" };
  const body = "Implement Orchid in a single responsive page with accessible signup. Verify keyboard navigation and mobile layout.";
  const o = { scenarioId: "documents-artifacts.write-plan", companyId: "company", origin: "https://fixture.test", leadId: "ceo",
    state: { task }, tasks: [task], projects: [], goals: [], comments: [],
    documents: [{ id: "document", key: "plan", latestRevisionId: "revision", body }],
    revisions: [{ id: "revision", body, createdByAgentId: "ceo", createdByRunId: "run" }],
    activity: [{ id: "audit", action: "issue.document_created", entityId: task.id, agentId: "ceo" }],
    reply: "Saved the implementation plan.", links: ["/RUN/issues/task"], humanQueries: [], runs: [{ id: "run", status: "succeeded" }] };
  expect(grade_documents_artifacts(o).passed).toBe(true);
  expect(grade_documents_artifacts({ ...o, revisions: [{ ...o.revisions[0], createdByAgentId: "other" }] }).passed).toBe(false);
  expect(grade_documents_artifacts({ ...o, documents: [] }).passed).toBe(false);
  expect(grade_documents_artifacts({ ...o, tasks: [{ ...task, status: "done" }] }).passed).toBe(false);
  expect(grade_documents_artifacts({ ...o, activity: [] }).passed).toBe(false);
});
