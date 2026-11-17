import { describe, expect, it } from "vitest";
import { ChaosApiError } from "./api.js";
import { handsOffSummary, invariantLine, readAssignedWorkInvariant } from "./hosted-handsoff.js";

describe("hosted hands-off numbers", () => {
  it("prints completed hands-off over started, banners shown, and Retry worked over clicked", () => {
    const banners = new Map([["i1", { firstShownAt: 1, shown: false, clearedAt: 2, clearedByItself: true }], ["i2", { firstShownAt: 3, shown: true, clearedAt: null, clearedByItself: false }],
      ["foreign", { firstShownAt: 1, shown: true, clearedAt: null, clearedByItself: false }]]);
    const summary = handsOffSummary({ completedWithoutHuman: 2, started: 3, retry: { tasks: 1, worked: 0, didNotWork: 1, pending: 0 } }, ["i1", "i2", "i3"], banners);
    expect(summary.lines).toEqual(["2 / 3 tasks completed hands-off", "Retry banner shown: 2 (cleared by itself: 1)", "Retry worked / clicked: 0 / 1"]);
  });
});

describe("assigned-work invariant read", () => {
  it("reads the company counts once and scopes the sample and stalled slots to the run", async () => {
    const api = { get: async <T>() => ({ openTasks: 7, checked: 7, truncated: false, violationCount: 3, violations: { no_owner: 2, held: 1 },
      sample: [{ identifier: "GIT-5", reason: "no_owner" }, { identifier: "OTHER-1", reason: "held" }],
      agentsWithStalledSlots: [{ agentName: "RC rc-x opencode", stalledRuns: 1, queuedRuns: 2 }, { agentName: "Someone", stalledRuns: 4, queuedRuns: 0 }] }) as T };
    const counts = await readAssignedWorkInvariant(api, "c1", { identifiers: new Set(["GIT-5"]), agentNames: new Set(["RC rc-x opencode"]) });
    expect(counts.run).toEqual({ sampledViolations: 1, byReason: { no_owner: 1 }, stalledSlots: [{ agentName: "RC rc-x opencode", stalledRuns: 1, queuedRuns: 2 }] });
    expect(invariantLine(counts)).toBe("Assigned-work invariant: company 3 violation(s) over 7 open task(s) [no_owner 2, held 1], 2 agent(s) with stalled slots; "
      + "this run: 1 sampled violation(s), 1 agent(s) with stalled slots.");
  });

  it("tolerates an older build without the endpoint", async () => {
    const api = { get: async <T>(): Promise<T> => { throw new ChaosApiError(404, "GET returned 404"); } };
    const counts = await readAssignedWorkInvariant(api, "c1", { identifiers: new Set(), agentNames: new Set() });
    expect(counts).toEqual({ available: false, status: 404 });
    expect(invariantLine(counts)).toBe("Assigned-work invariant: not available on this build (HTTP 404).");
  });
});
