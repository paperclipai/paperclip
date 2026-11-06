import { it, expect } from "vitest";
import { gradeDependencyCycle } from "./runtime-task-coordination.js";
function valid() {
  const website = { id: "website", title: "Website", companyId: "company", status: "backlog", blockedBy: [] };
  const design = { id: "design", title: "Design", companyId: "company", status: "backlog", blockedBy: [{ id: "website" }] };
  return { scenarioId: "task-coordination.reject-dependency-cycle", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task: website, design }, dependencyTasks: [structuredClone(website), structuredClone(design)], agents: [], tasks: [website, design],
    links: ["/ACORN/issues/website", "/ACORN/issues/design"], reply: "Design already depends on Website. That would be circular. Choose which should go first.",
    activity: [], runs: [], humanQueries: [] };
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
