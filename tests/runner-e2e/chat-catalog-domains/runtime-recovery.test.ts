import { it, expect } from "vitest";
import { gradeControllerRestart } from "./runtime-recovery.js";
function valid() {
  const initial = { contentVerified: true, content: "<h1>Unpredictable Orchid header</h1>", attachmentId: "initial", workProductId: "initial-product" };
  const final = { contentVerified: true, content: "<h1>Unpredictable Orchid header</h1><section>Contact hello@acorn.example</section>", attachmentId: "final", workProductId: "final-product" };
  return { scenarioId: "recovery.controller-restart", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { initialArtifact: initial, finalArtifact: final, fileBeforeRestart: initial.content, fileAfterRestart: initial.content, restarted: true,
      headerMarker: "Unpredictable Orchid header", finalFile: final.content, initialRunId: "first", sourceIssueBefore: "chat", sourceIssueAfter: "chat", priorHistoryRetained: true },
    agents: [], tasks: [], links: ["/api/attachments/final/content?download=1"], reply: "The website is ready.", activity: [], humanQueries: [],
    runs: [{ id: "first", agentId: "ceo", status: "succeeded" }, { id: "second", agentId: "ceo", status: "succeeded" }] };
}
it("accepts real persisted bytes and one attributed continuation", () => expect(gradeControllerRestart(valid()).passed).toBe(true));
it("rejects missing restart evidence", () => expect(gradeControllerRestart(undefined).passed).toBe(false));
it("rejects claiming continuation when prior actual files were lost", () => {
  const o = valid(); o.state.fileAfterRestart = ""; expect(gradeControllerRestart(o).passed).toBe(false);
});
it("rejects final work that forgot the persisted contact instruction", () => {
  const o = valid(); o.state.finalArtifact.content = o.state.initialArtifact.content; o.state.finalFile = o.state.finalArtifact.content;
  expect(gradeControllerRestart(o).passed).toBe(false);
});
it("rejects source-history replacement", () => {
  const o = valid(); o.state.sourceIssueAfter = "new-chat"; expect(gradeControllerRestart(o).passed).toBe(false);
});
it("rejects a duplicate delegated execution task", () => {
  const o = valid(); (o.tasks as Array<{ id: string }>).push({ id: "duplicate-work" }); expect(gradeControllerRestart(o).passed).toBe(false);
});

it("accepts usable registered final work without a mandatory chat hyperlink", () => {
  const o = valid(); o.links = []; expect(gradeControllerRestart(o).passed).toBe(true);
});
