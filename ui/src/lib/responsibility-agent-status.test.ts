import { describe, expect, it } from "vitest";
import {
  ALL_FIXTURE_AREAS,
  fundraisingBehind,
  homeOverviewFixture,
  metricFixture,
  RESPONSIBILITY_FIXTURE_OWNER_ID,
} from "../../storybook/fixtures/responsibilities";
import {
  allFreshStatusReportsFixture,
  denseAgentStatusOverviewFixture,
  denseStatusReportsFixture,
  mixedStatusReportsFixture,
  noneWrittenStatusReportsFixture,
} from "../../storybook/fixtures/responsibility-status-reports";
import {
  agentStatusAreaGroups,
  agentStatusMetricCell,
  agentStatusRows,
  agentStatusTiles,
  areaStatusKind,
  composeAgentStatusSummary,
} from "./responsibility-agent-status";

const names: Record<string, string> = { "agent-codex": "CodexCoder", "agent-cto": "CTO", "agent-qa": "QA" };
const agentName = (id: string) => names[id];
const rows = (reports = mixedStatusReportsFixture) => agentStatusRows(homeOverviewFixture.responsibilities, reports);
const byId = (id: string, reports = mixedStatusReportsFixture) => rows(reports).find((row) => row.responsibility.id === id)!;

describe("a row's status", () => {
  it("uses the agent's report when there is one", () => {
    expect(byId("resp-fundraising")).toMatchObject({ kind: "behind", label: "Behind", source: "agent", authorAgentId: "agent-codex", outOfDate: false });
  });
  it("keeps an out-of-date report, marked", () => {
    expect(byId("resp-lp-updates")).toMatchObject({ kind: "at_risk", source: "agent", outOfDate: true });
  });
  it("says when a person wrote it", () => {
    expect(byId("resp-board-reporting")).toMatchObject({ source: "person", authorUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, authorAgentId: null });
  });
  it("falls back to the number, saying so, with whose view it waits for", () => {
    expect(byId("resp-hiring")).toMatchObject({
      kind: "unclear", label: "Not measured", source: "number", reporterAgentId: "agent-cto", updateRequested: true,
      message: homeOverviewFixture.responsibilities.find((item) => item.id === "resp-hiring")!.rollup.statusSentence,
    });
  });
  it("reads an agent's 'cannot tell yet' as unclear", () => {
    expect(byId("resp-hiring", allFreshStatusReportsFixture)).toMatchObject({ kind: "unclear", label: "Can't tell yet", source: "agent" });
  });
});

describe("the four numbers", () => {
  it("count each responsibility by the status it shows, and say where those come from", () => {
    const tiles = agentStatusTiles(rows());
    expect(tiles.tiles.map((tile) => [tile.label, tile.value, tile.line])).toEqual([
      ["On track", 1, "Of 5 responsibilities"],
      ["At risk", 2, "In 2 areas"],
      ["Behind", 1, "In 1 area"],
      ["Unclear", 1, "1 not measured"],
    ]);
    expect(tiles.provenance).toBe("3 written by agents · 1 out of date · 1 written by a person · 1 from the number");
  });
  it("read sensibly with nothing written", () => {
    const tiles = agentStatusTiles(rows(noneWrittenStatusReportsFixture));
    expect(tiles.byAgent).toBe(0);
    expect(tiles.provenance).toBe("0 written by agents · 5 from the numbers");
  });
});

describe("the summary", () => {
  it("leads with how much is written, then the most concerning messages, attributed, then whose update is awaited", () => {
    const summary = composeAgentStatusSummary(rows(), agentName, RESPONSIBILITY_FIXTURE_OWNER_ID);
    expect(summary.lead).toBe("4 of your 5 statuses are written; the rest come from the numbers. They put 1 behind and 2 at risk. 1 is older than 7 days.");
    expect(summary.lines.map((line) => [line.row.responsibility.title, line.by])).toEqual([
      ["Seed extension", "CodexCoder"],
      ["Board reporting", "You"],
      ["LP updates", "CTO"],
    ]);
    expect(summary.waiting).toBe("CTO, for 1 update");
  });
  it("says plainly when no agent has written anything", () => {
    expect(composeAgentStatusSummary(rows(noneWrittenStatusReportsFixture), agentName, null)).toEqual({
      lead: "No agent has written a status yet. Every status below comes from the numbers.",
      lines: [],
      waiting: null,
    });
  });
  it("says when everything is written and nothing is wrong", () => {
    const fresh = rows(allFreshStatusReportsFixture).filter((row) => row.kind === "on_track");
    expect(composeAgentStatusSummary(fresh, agentName, null).lead).toBe("All 2 of your statuses are written. None of the written ones is behind or at risk.");
  });
});

describe("areas", () => {
  it("give each area its worst status, its most concerning line, the share on track and who reports there", () => {
    const groups = agentStatusAreaGroups(ALL_FIXTURE_AREAS, rows(), agentName, RESPONSIBILITY_FIXTURE_OWNER_ID);
    const fundraising = groups.find((group) => group.area?.id === "area-fundraising")!;
    expect(fundraising.kind).toBe("behind");
    expect(fundraising.headline).toEqual({ text: "Nine of twenty contacted, and the deck the rest are waiting for is three days late.", by: "CodexCoder", fromNumber: false });
    expect(fundraising.onTrackLabel).toBe("0 of 2 responsibilities on track");
    expect(fundraising.agentIds).toEqual(["agent-codex", "agent-cto"]);
    const team = groups.find((group) => group.area?.id === "area-team")!;
    expect(team).toMatchObject({ kind: "unclear", headline: { by: null, fromNumber: true } });
    const loose = groups.at(-1)!;
    expect(loose.area).toBeNull();
    expect(loose.rows.map((row) => row.responsibility.id)).toEqual(["resp-board-reporting"]);
  });
  it("is unclear only when nothing in it has a clearer status", () => {
    expect(areaStatusKind([{ kind: "unclear" }, { kind: "on_track" }])).toBe("on_track");
    expect(areaStatusKind([{ kind: "unclear" }])).toBe("unclear");
    expect(areaStatusKind([])).toBeNull();
  });
  it("holds 46 responsibilities across 22 areas", () => {
    const dense = agentStatusRows(denseAgentStatusOverviewFixture.responsibilities, denseStatusReportsFixture);
    const groups = agentStatusAreaGroups(denseAgentStatusOverviewFixture.areas, dense, agentName, null);
    expect(dense).toHaveLength(46);
    expect(groups).toHaveLength(22);
    expect(groups.every((group) => group.rows.length >= 2)).toBe(true);
  });
});

describe("the metric column", () => {
  it("reads every bar template through the shared helper", () => {
    expect(agentStatusMetricCell(metricFixture({ name: "LCP p75", unit: "s", target: 2, current: 2.4, direction: "at_most" })))
      .toEqual({ label: "LCP p75", value: "2.4 s", target: "target at most 2 s" });
    expect(agentStatusMetricCell(metricFixture({ name: "Investors contacted", target: 20, current: 9 })))
      .toEqual({ label: "Investors contacted", value: "9", target: "target 20" });
    expect(agentStatusMetricCell(metricFixture({ kind: "range", name: "Runway", unit: "months", target: null, low: 12, high: 24, current: 10 })))
      .toEqual({ label: "Runway", value: "10 months", target: "range 12–24 months" });
    expect(agentStatusMetricCell(metricFixture({ kind: "yes_no", name: "Board pack sent a week ahead", target: null, current: 1 })))
      .toEqual({ label: "Board pack sent a week ahead", value: "Yes", target: "should be yes" });
    expect(agentStatusMetricCell(metricFixture({ name: "Investors contacted", target: 20, current: null })))
      .toEqual({ label: "Investors contacted", value: "No reading yet", target: "target 20" });
    expect(agentStatusMetricCell(fundraisingBehind.rollup.metric)?.label).toBe("Investors contacted");
    expect(agentStatusMetricCell(null)).toBeNull();
  });
});
