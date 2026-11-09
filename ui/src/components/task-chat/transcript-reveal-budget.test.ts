import { describe, expect, it } from "vitest";
import { selectBudgetedTranscriptRuns } from "./transcript-reveal-budget";

const STATUSES = ["running", "queued", "failed", "succeeded", "cancelled"] as const;

function createRuns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `run-${index}`,
    status: STATUSES[index % STATUSES.length]!,
  }));
}

describe("selectBudgetedTranscriptRuns", () => {
  it("budgets live runs without anchors and settled runs only in compact history", () => {
    const runs = [
      { id: "live", status: "running" },
      { id: "steered", status: "running" },
      { id: "failed", status: "failed" },
    ];
    const hasTimelineAnchors = (run: { id: string }) => run.id === "steered";
    expect(selectBudgetedTranscriptRuns(runs, { compactDeferral: true, hasTimelineAnchors })).toEqual([
      { runId: "live", settled: false },
      { runId: "failed", settled: true },
    ]);
    expect(selectBudgetedTranscriptRuns(runs, { compactDeferral: false, hasTimelineAnchors })).toEqual([
      { runId: "live", settled: false },
    ]);
  });

  it("does one anchor lookup for each live run in a large task", () => {
    const runs = createRuns(5_000);
    const liveRunCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;
    let lookups = 0;
    const hasTimelineAnchors = (run: { id: string }) => {
      lookups += 1;
      if (lookups > liveRunCount) throw new Error(`anchor lookups exceeded ${liveRunCount}`);
      return Number(run.id.slice("run-".length)) % 2 === 0;
    };
    const budgeted = selectBudgetedTranscriptRuns(runs, { compactDeferral: true, hasTimelineAnchors });
    expect(lookups).toBe(liveRunCount);
    expect(budgeted.filter((run) => run.settled)).toHaveLength(runs.length - liveRunCount);
    expect(budgeted.filter((run) => !run.settled)).toHaveLength(liveRunCount / 2);
  });
});
