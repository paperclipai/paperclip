import { describe, expect, it } from "vitest";
import { responsibilityDashboardChangeSummary, type ResponsibilityDashboardSnapshot } from "@paperclipai/shared";
import { createSizedChanges, smallEditChanges } from "../../storybook/fixtures/responsibility-dashboard";
import {
  dashboardChangeGroups,
  dashboardChangeLine,
  dashboardVersionWho,
  droppedWithArea,
  keptDashboardChanges,
  lettingGoWith,
  toggleDashboardChange,
} from "./responsibility-dashboard";

describe("dashboard change groups", () => {
  it("groups by area in the order named, area changes first", () => {
    expect(dashboardChangeGroups(createSizedChanges).map((group) => [group.name, group.isNew, group.changes.map((change) => change.index)])).toEqual([
      ["Fundraising", true, [0, 1, 2]],
      ["Portfolio", true, [3, 4, 5]],
      ["Team", true, [6, 7]],
      ["Board", true, [8, 9]],
    ]);
    expect(dashboardChangeGroups(smallEditChanges).find((group) => group.name === "Team")!.changes.map((change) => change.op))
      .toEqual(["rename_area", "remove_responsibility"]);
  });

  it("separates area edits from responsibility edits and identifies existing parents", () => {
    const groups = dashboardChangeGroups([
      ...createSizedChanges.slice(0, 3),
      smallEditChanges[2]!,
      smallEditChanges[3]!,
      { ...smallEditChanges[0]!, index: 10, groupAreaId: null, groupName: "No area" },
    ]);
    expect(groups.map((group) => ({
      name: group.name,
      existing: group.hasExistingArea,
      areaEdits: group.areaChanges.map((change) => change.op),
      responsibilityEdits: group.responsibilityChanges.map((change) => change.op),
    }))).toEqual([
      { name: "Fundraising", existing: false, areaEdits: ["add_area"], responsibilityEdits: ["add_responsibility", "add_responsibility"] },
      { name: "Team", existing: true, areaEdits: ["rename_area"], responsibilityEdits: ["remove_responsibility"] },
      { name: "No area", existing: false, areaEdits: [], responsibilityEdits: ["reword_responsibility"] },
    ]);
  });
});

describe("dropping and keeping", () => {
  it("drops a new area with what is filed under it, and brings the area back with one of them", () => {
    const dropped = toggleDashboardChange(createSizedChanges, new Set(), 3);
    expect([...dropped].sort()).toEqual([3, 4, 5]);
    expect(droppedWithArea(createSizedChanges, dropped, createSizedChanges[4]!)).toBe("Portfolio");
    expect(droppedWithArea(createSizedChanges, dropped, createSizedChanges[3]!)).toBeNull();
    const back = toggleDashboardChange(createSizedChanges, dropped, 5);
    expect([...back].sort()).toEqual([4]);
    expect(keptDashboardChanges(createSizedChanges, back)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
    expect(keptDashboardChanges(createSizedChanges, new Set())).toBeUndefined();
    // Dropping something with nothing under it drops only itself.
    expect([...toggleDashboardChange(createSizedChanges, new Set(), 1)]).toEqual([1]);
  });

  it("lists what a removed area lets go of, including what a dropped move would have saved", () => {
    const changes = [
      { ...smallEditChanges[1]!, index: 0, fromAreaId: "area-fundraising", groupAreaId: "area-portfolio" },
      {
        ...smallEditChanges[2]!, index: 1, op: "remove_area" as const, groupAreaId: "area-fundraising", groupName: "Fundraising",
        responsibilityId: null, fromSentence: null, lettingGo: [{ id: "resp-deck", sentence: "The deck is current." }],
      },
    ];
    expect(lettingGoWith(changes, new Set(), changes[1]!)).toEqual(["The deck is current."]);
    expect(lettingGoWith(changes, new Set([0]), changes[1]!)).toEqual(["The deck is current.", "LP updates go out by the 5th of each month."]);
  });
});

describe("version words", () => {
  it("names who caused a version and the line beside Undo", () => {
    const name = (id: string) => (id === "agent-1" ? "Chief" : undefined);
    expect(dashboardVersionWho({ cause: "change_set", actorAgentId: "agent-1" }, name)).toBe("Chief");
    expect(dashboardVersionWho({ cause: "change_set", actorAgentId: "agent-gone" }, name)).toBe("An agent");
    // A change the agent made with its responsibility tools, not a proposal the person applied.
    expect(dashboardVersionWho({ cause: "change_set", actorAgentId: "agent-1", interactionId: null }, name)).toBe("Chief, for you");
    expect(dashboardVersionWho({ cause: "change_set", actorAgentId: "agent-1", interactionId: "card-1" }, name)).toBe("Chief");
    expect(dashboardVersionWho({ cause: "person", actorAgentId: null }, name)).toBe("You");
    expect(dashboardVersionWho({ cause: "restore", actorAgentId: null }, name)).toBe("Restored");
    expect(dashboardChangeLine({ cause: "change_set", summary: "Added 1 area" })).toBe("Added 1 area.");
    expect(dashboardChangeLine({ cause: "restore", summary: "Let go of 2 responsibilities" })).toBe("Restored an earlier version.");
  });

  it("summarizes what changed between two snapshots in one line", () => {
    const snapshot = (areas: Array<[string, string, string?]>, items: Array<[string, string, string | null, string?]>): ResponsibilityDashboardSnapshot => ({
      version: 1,
      areas: areas.map(([id, title, status]) => ({ id, title, status: status ?? "active", sortOrder: 0 })),
      responsibilities: items.map(([id, title, areaId, standard]) => ({ id, title, standard: standard ?? null, areaId, status: "active", sortOrder: 0 })),
      createdAreaIds: [],
    });
    const before = snapshot([["a", "Fundraising"], ["b", "Hiring"]], [["1", "LPs hear from us.", "a"], ["2", "Deck current.", "a"], ["3", "Pipeline", "b", "Three candidates per role."]]);
    expect(responsibilityDashboardChangeSummary(null, snapshot([], []))).toBe("Empty");
    expect(responsibilityDashboardChangeSummary(null, before)).toBe("2 areas, 3 responsibilities");
    expect(responsibilityDashboardChangeSummary(before, before)).toBe("No changes");
    const after = snapshot(
      [["a", "Capital"], ["b", "Hiring", "archived"], ["c", "People"]],
      [["1", "LPs hear from us weekly.", "a"], ["3", "Pipeline", "c", "Three candidates per role."], ["4", "Onboarding takes a week.", "c"]],
    );
    expect(responsibilityDashboardChangeSummary(before, after))
      .toBe("Added 1 area and 1 responsibility, renamed 1 area, reworded 1 responsibility, moved 1 responsibility, removed 1 area and let go of 1 responsibility");
  });
});
