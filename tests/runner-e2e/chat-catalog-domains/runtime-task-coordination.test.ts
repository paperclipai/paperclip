import { it, expect } from "vitest";
import { gradeDependencyCycle } from "./runtime-task-coordination.js";
function valid() {
  const website = { id: "website", title: "Website", companyId: "company", status: "backlog", blockedBy: [] };
  const design = { id: "design", title: "Design", companyId: "company", status: "backlog", blockedBy: [{ id: "website" }] };
  return { scenarioId: "task-coordination.reject-dependency-cycle", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task: website, design }, dependencyTasks: [structuredClone(website), structuredClone(design)], agents: [], tasks: [website, design],
    links: ["/ACORN/issues/website", "/ACORN/issues/design"], reply: "Design already depends on Website. That would be circular. Choose which should go first.",
    activity: [], runs: [{ id: "run" }], humanQueries: [], conversationInteractions: [] as Array<Record<string, unknown>> };
}
/** The pending card retained from run 42678089404, which ended the turn with an empty reply. */
function card() {
  return { id: "card", kind: "ask_user_questions", status: "pending", companyId: "company", createdByAgentId: "ceo", sourceRunId: "run",
    resolverPolicy: "human_only", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
    title: "Choose dependency order",
    summary: "Design (COM-2) currently waits for Website (COM-1). Paperclip won't let Website also wait for Design because that would be a dependency cycle, so which order should I keep?",
    payload: { version: 1, questions: [{ id: "order", prompt: "Which dependency order should I set?", selectionMode: "single",
      options: [{ id: "website_waits_design", label: "Website waits for Design" }, { id: "keep_design_waits_website", label: "Keep current order" }] }] } };
}
function withCard(edit: (row: ReturnType<typeof card>) => void = () => {}) {
  const o = valid(); o.reply = ""; const row = card(); edit(row); o.conversationInteractions = [row]; return o;
}
it("accepts an independently saved acyclic rejection", () => expect(gradeDependencyCycle(valid()).passed).toBe(true));
it("accepts natural actionable cycle explanation", () => { const o = valid(); o.reply = "Design already waits for Website. Adding the reverse edge would make a dependency cycle; tell me which task should go first."; expect(gradeDependencyCycle(o).passed).toBe(true); });
it("rejects missing dependency detail", () => expect(gradeDependencyCycle(undefined).passed).toBe(false));
it("rejects a plausible explanation with the cycle actually saved", () => {
  const o = valid(); o.dependencyTasks[0]!.blockedBy = [{ id: "design" }]; expect(gradeDependencyCycle(o).passed).toBe(false);
});
it("rejects silently deleting the original prerequisite", () => {
  const o = valid(); o.dependencyTasks[1]!.blockedBy = []; expect(gradeDependencyCycle(o).passed).toBe(false);
});
it("rejects a conflict with no actionable order decision", () => {
  const o = valid(); o.reply = "Website and Design form a cycle."; expect(gradeDependencyCycle(o).passed).toBe(false);
});

it("accepts a saved acyclic rejection naming both tasks without mandatory chat hrefs", () => {
  const o = valid(); o.links = []; expect(gradeDependencyCycle(o).passed).toBe(true);
});

it("accepts this run's pending order card when the turn ends on it", () => expect(gradeDependencyCycle(withCard()).passed).toBe(true));
it("accepts a reworded order card naming both tasks", () => expect(gradeDependencyCycle(withCard(row => {
  row.title = "Dependency order"; row.summary = "Website can't wait for Design while Design waits for Website.";
  row.payload.questions[0]!.prompt = "What should happen?";
  row.payload.questions[0]!.options = [{ id: "a", label: "Design first" }, { id: "b", label: "Swap so Website goes after Design" }];
})).passed).toBe(true));
it("rejects an empty reply with no card", () => { const o = valid(); o.reply = ""; expect(gradeDependencyCycle(o).passed).toBe(false); });
it("rejects a card from another run, agent or with one choice", () => {
  expect(gradeDependencyCycle(withCard(row => { row.sourceRunId = "other"; })).passed).toBe(false);
  expect(gradeDependencyCycle(withCard(row => { row.createdByAgentId = "someone"; })).passed).toBe(false);
  expect(gradeDependencyCycle(withCard(row => { row.status = "answered"; })).passed).toBe(false);
  expect(gradeDependencyCycle(withCard(row => { row.payload.questions[0]!.options = row.payload.questions[0]!.options.slice(0, 1); })).passed).toBe(false);
});
it("rejects a card that does not name both tasks", () => expect(gradeDependencyCycle(withCard(row => {
  row.title = "Choose order"; row.summary = "That would be a cycle."; row.payload.questions[0]!.prompt = "Which order?";
  row.payload.questions[0]!.options = [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }];
})).passed).toBe(false));
it("rejects a valid card when the original prerequisite was swapped", () => {
  const o = withCard(); o.dependencyTasks[1]!.blockedBy = []; o.dependencyTasks[0]!.blockedBy = [{ id: "design" }];
  expect(gradeDependencyCycle(o).passed).toBe(false);
});
