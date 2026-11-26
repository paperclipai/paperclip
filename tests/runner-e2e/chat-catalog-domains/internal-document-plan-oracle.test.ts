import { expect, it } from "vitest";
import { grade_documents_artifacts, planCoversBrief } from "./internal-documents-artifacts.js";

// The plan the CEO saved in run 42404417252 (abridged to its substantive lines).
const observedPlan = `# Orchid Single-Page Website — Implementation Plan
Ship a responsive single-page marketing site for Orchid with an accessible signup flow, verified keyboard navigation, and correct mobile presentation.
1. Scaffold — semantic landmarks and base typography.
2. Content & Layout — responsive CSS (flex/grid, mobile-first breakpoints).
3. Accessible Signup — labeled inputs and inline validation.
5. Verification — Test keyboard-only navigation end to end and check responsive layout at mobile/tablet/desktop widths.`;

it.each([
  observedPlan,
  observedPlan.replaceAll("mobile", "phone"),
  observedPlan.replaceAll("keyboard", "tab-key"),
  observedPlan.replaceAll("single-page", "landing-page").replaceAll("Single-Page", "Landing Page"),
  "# Orchid website plan\n1. Build the one-page Orchid site with a responsive layout and an accessible sign-up form.\n2. Verify it works with keyboard only and looks right on phones.",
  "Develop one accessible web page for Orchid registration, using responsive breakpoints. Test keyboard navigation and mobile presentation.",
])("accepts plans grounded in the brief regardless of wording: %s", body => {
  expect(planCoversBrief(body)).toBe(true);
});
it.each([
  "",
  "# Plan\n1. Implement the website.\n2. Test it.",
  "# Plan\n1. Gather requirements.\n2. Implement the solution.\n3. Review and ship.",
  "# Birch inventory app\n1. Build a native app for warehouse barcode scanning.\n2. Sync stock counts to the ERP nightly.\n3. Test offline mode.",
])("rejects generic or foreign plans: %s", body => {
  expect(planCoversBrief(body)).toBe(false);
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
