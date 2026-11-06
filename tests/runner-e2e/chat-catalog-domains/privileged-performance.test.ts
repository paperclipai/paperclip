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
it("accepts ordinary display rounding and the reversed phrasing of a production limitation", () => {
  const o = valid(); o.state.interpretation.reply = "The synthetic fixture mount was 12 ms. Production throughput cannot be inferred from these render timings.";
  expect(gradeLongThreadPerformance(o).passed).toBe(true);
});
it("rejects invented timings and swaps between named metrics", () => {
  for (const text of ["The synthetic fixture mount was 500 ms. It does not prove production throughput.",
    "The synthetic fixture mount was 20.4 ms. It does not prove production throughput."]) {
    const o = valid(); o.state.interpretation.reply = text; expect(gradeLongThreadPerformance(o).passed).toBe(false);
  }
});
it("rejects wrong data size, unrelated phase and unmeasured production throughput", () => {
  const o = valid(); o.state.interpretation.reply += " Production throughput is 100 requests per second.";
  expect(gradeLongThreadPerformance(o).passed).toBe(false);
  const wrong = valid(); wrong.state.interpretation.reply = wrong.state.interpretation.reply.replace("487 rows", "900 rows");
  expect(gradeLongThreadPerformance(wrong).passed).toBe(false);
  const phase = valid(); phase.state.interpretation.attributed = false; expect(gradeLongThreadPerformance(phase).passed).toBe(false);
  expect(gradeLongThreadPerformance(null).passed).toBe(false);
});
it("rejects generic fixture advice that describes no observed measurement", () => {
  const o = valid(); o.state.interpretation.reply = "This synthetic render fixture cannot establish production throughput or model latency.";
  expect(gradeLongThreadPerformance(o).passed).toBe(false);
  o.state.interpretation.reply = "The synthetic fixture shows 2 profiler commits. This render observation does not establish production throughput.";
  expect(gradeLongThreadPerformance(o).passed).toBe(true);
});
