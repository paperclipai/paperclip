import { expect, it } from "vitest";
import { gradeLongThreadPerformance } from "./privileged-performance.js";
function valid() {
  return { scenarioId: "developer-labs.long-thread-performance", origin: "http://owned.invalid", companyId: "owned", leadId: "lead",
    tasks: [], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical", "actual report"],
    runs: [{ id: "initial", agentId: "lead", status: "succeeded" }, { id: "interpret", agentId: "lead", status: "succeeded" }], reply: "initial guidance",
    state: { performanceReport: { scope: "fixed synthetic UI", commentCount: 469, rowCount: 487, markdownCount: 150,
      mountMs: 12.3, latestMs: 8.1, maximumMs: 12.3, totalMs: 20.4, commitCount: 2, fixtureSha256: "a".repeat(64),
      environment: { browser: "real browser", measuredAt: "2026-10-26T23:00:00Z" } },
      interpretation: { attributed: true, humanCommentId: "real-human-report", runId: "interpret",
        reply: "The synthetic fixture rendered 487 rows with 469 comments. Mount was 12.3 ms; total was 20.4 ms. This measures render cost, not production throughput or model latency." } } };
}
it("accepts actual fixed-fixture measurements and attributed limited interpretation", () => expect(gradeLongThreadPerformance(valid()).passed).toBe(true));
it("does not parse the interpretation's numbers or wording", () => {
  for (const text of ["Encouraging at ~470 comments (mount ~0.27s, append ~22ms); add points such as 50 comments to see the growth curve.",
    "Rendering the big thread took about half a second to mount. That is one local page load, so it says nothing about live traffic."]) {
    const o = valid(); o.state.interpretation.reply = text; expect(gradeLongThreadPerformance(o).passed).toBe(true);
  }
});
it("rejects a reply not bound to the persisted report, or an unmeasured report", () => {
  const phase = valid(); phase.state.interpretation.attributed = false; expect(gradeLongThreadPerformance(phase).passed).toBe(false);
  const empty = valid(); empty.state.interpretation.reply = ""; expect(gradeLongThreadPerformance(empty).passed).toBe(false);
  const extra = valid(); extra.runs.push({ id: "third", agentId: "lead", status: "succeeded" }); expect(gradeLongThreadPerformance(extra).passed).toBe(false);
  const pending = valid(); pending.state.performanceReport.mountMs = Number.NaN; expect(gradeLongThreadPerformance(pending).passed).toBe(false);
  const size = valid(); size.state.performanceReport.rowCount = 12; expect(gradeLongThreadPerformance(size).passed).toBe(false);
  expect(gradeLongThreadPerformance(null).passed).toBe(false);
});
