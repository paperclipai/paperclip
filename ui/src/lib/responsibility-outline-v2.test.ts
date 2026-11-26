import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areaDealFlow,
  areaFundraising,
  areaLegal,
  areaPortfolio,
  boardReportingOverridden,
  fundraisingBehind,
  lpUpdatesStale,
  portfolioOnTrack,
  responsibilityFixture,
} from "../../storybook/fixtures/responsibilities";
import {
  OUTLINE_V2_COLLAPSED_STORAGE_KEY,
  OUTLINE_V2_NO_AREA_KEY,
  outlineV2Counts,
  outlineV2CountsLabel,
  outlineV2Groups,
  outlineV2Href,
  outlineV2Line,
  readCollapsedAreas,
  searchOutlineV2Groups,
  writeCollapsedAreas,
} from "./responsibility-outline-v2";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("outlineV2Groups", () => {
  it("lists every active area, any other area holding one, then no area, keeping the overview's order", () => {
    const inDealFlow = responsibilityFixture({ id: "resp-sourcing", areaId: areaDealFlow.id, title: "Sourcing" });
    const letGo = responsibilityFixture({ id: "resp-old", areaId: areaPortfolio.id, title: "Old", status: "let_go" });
    const groups = outlineV2Groups(
      [areaFundraising, areaPortfolio, areaLegal, areaDealFlow],
      [lpUpdatesStale, boardReportingOverridden, fundraisingBehind, inDealFlow, portfolioOnTrack, letGo],
    );
    expect(groups.map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([
      // At risk stays before behind: nothing here sorts by status.
      ["area-fundraising", ["resp-lp-updates", "resp-fundraising"]],
      ["area-portfolio", ["resp-portfolio"]],
      ["area-legal", []],
      ["area-deal-flow", ["resp-sourcing"]],
      [OUTLINE_V2_NO_AREA_KEY, ["resp-board-reporting"]],
    ]);
  });

  it("leaves out a proposed area with nothing in it, unless it was just added", () => {
    expect(outlineV2Groups([areaDealFlow], []).map((group) => group.key)).toEqual([]);
    expect(outlineV2Groups([areaDealFlow], [], new Set([areaDealFlow.id])).map((group) => group.key)).toEqual([areaDealFlow.id]);
  });
});

describe("outlineV2Line and outlineV2Href", () => {
  it("reads the bar sentence, or the title when there is none", () => {
    expect(outlineV2Line(fundraisingBehind)).toBe(fundraisingBehind.standard);
    expect(outlineV2Line({ title: "Token coverage", standard: null })).toBe("Token coverage");
    expect(outlineV2Line({ title: "Token coverage", standard: "   " })).toBe("Token coverage");
  });

  it("opens the responsibility in its simplified view", () => {
    expect(outlineV2Href("resp 1")).toBe("/responsibilities/resp%201?view=one_screen_v2");
  });
});

describe("outlineV2Counts and outlineV2CountsLabel", () => {
  it("counts areas and every responsibility, with or without an area", () => {
    const groups = outlineV2Groups(
      [areaFundraising, areaPortfolio, areaLegal],
      [lpUpdatesStale, boardReportingOverridden, fundraisingBehind, portfolioOnTrack],
    );
    expect(outlineV2Counts(groups)).toEqual({ areas: 3, responsibilities: 4 });
    expect(outlineV2CountsLabel(outlineV2Counts(groups))).toBe("3 areas and 4 responsibilities");
  });

  it("uses the singular for one", () => {
    expect(outlineV2CountsLabel({ areas: 1, responsibilities: 1 })).toBe("1 area and 1 responsibility");
    expect(outlineV2CountsLabel({ areas: 0, responsibilities: 2 })).toBe("0 areas and 2 responsibilities");
  });
});

describe("searchOutlineV2Groups", () => {
  const sourcing = responsibilityFixture({
    id: "resp-sourcing",
    areaId: areaDealFlow.id,
    title: "Sourcing",
    standard: "We see every seed round in developer tools.",
  });
  const diligence = responsibilityFixture({
    id: "resp-diligence",
    areaId: areaDealFlow.id,
    title: "Diligence",
    standard: "Every deal gets a written memo.",
  });
  const groups = outlineV2Groups(
    [areaFundraising, areaDealFlow],
    [fundraisingBehind, sourcing, diligence],
    new Set([areaDealFlow.id]),
  );
  const shape = (found: ReturnType<typeof searchOutlineV2Groups>) =>
    found.map((group) => [group.key, group.items.map((item) => item.id)]);

  it("returns every group for a blank search", () => {
    expect(shape(searchOutlineV2Groups(groups, "   "))).toEqual(shape(groups));
  });

  it("keeps only matching responsibilities and drops areas with none", () => {
    expect(shape(searchOutlineV2Groups(groups, "MEMO"))).toEqual([[areaDealFlow.id, ["resp-diligence"]]]);
    expect(shape(searchOutlineV2Groups(groups, "sourcing"))).toEqual([[areaDealFlow.id, ["resp-sourcing"]]]);
  });

  it("keeps a whole area when its name matches", () => {
    expect(shape(searchOutlineV2Groups(groups, areaDealFlow.title))).toEqual([
      [areaDealFlow.id, ["resp-sourcing", "resp-diligence"]],
    ]);
  });

  it("needs every word, across the area's name and the responsibility", () => {
    const word = areaDealFlow.title.split(" ")[0]!;
    expect(shape(searchOutlineV2Groups(groups, `${word} memo`))).toEqual([[areaDealFlow.id, ["resp-diligence"]]]);
    expect(searchOutlineV2Groups(groups, "memo zebra")).toEqual([]);
  });
});

describe("collapsed areas in storage", () => {
  it("round-trips, and ignores anything that is not a list of keys", () => {
    writeCollapsedAreas(new Set(["area-a", OUTLINE_V2_NO_AREA_KEY]), "owner");
    expect([...readCollapsedAreas("owner")]).toEqual(["area-a", OUTLINE_V2_NO_AREA_KEY]);
    localStorage.setItem(`${OUTLINE_V2_COLLAPSED_STORAGE_KEY}:owner`, "{not json");
    expect(readCollapsedAreas("owner").size).toBe(0);
    localStorage.setItem(`${OUTLINE_V2_COLLAPSED_STORAGE_KEY}:owner`, JSON.stringify({ a: 1 }));
    expect(readCollapsedAreas("owner").size).toBe(0);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readCollapsedAreas("owner").size).toBe(0);
    expect(() => writeCollapsedAreas(new Set(["area-a"]), "owner")).not.toThrow();
  });
});
