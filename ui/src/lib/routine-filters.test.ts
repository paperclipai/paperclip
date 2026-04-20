import { describe, expect, it } from "vitest";
import {
  applyRoutineFilters,
  countActiveRoutineFilters,
  normalizeRoutineFilterState,
  routineDisplayStatus,
  toggleRoutineFilterStatus,
} from "./routine-filters";

describe("routine-filters", () => {
  describe("routineDisplayStatus", () => {
    it("maps archived status to archived regardless of agent", () => {
      expect(routineDisplayStatus({ status: "archived", assigneeAgentId: null })).toBe("archived");
      expect(routineDisplayStatus({ status: "archived", assigneeAgentId: "agent-1" })).toBe("archived");
    });

    it("maps paused status to off", () => {
      expect(routineDisplayStatus({ status: "paused", assigneeAgentId: "agent-1" })).toBe("off");
    });

    it("maps active without an assignee to draft", () => {
      expect(routineDisplayStatus({ status: "active", assigneeAgentId: null })).toBe("draft");
    });

    it("maps active with an assignee to on", () => {
      expect(routineDisplayStatus({ status: "active", assigneeAgentId: "agent-1" })).toBe("on");
    });
  });

  describe("applyRoutineFilters", () => {
    const routines = [
      { id: "1", status: "active", assigneeAgentId: "agent-1" },
      { id: "2", status: "paused", assigneeAgentId: "agent-1" },
      { id: "3", status: "active", assigneeAgentId: null },
      { id: "4", status: "archived", assigneeAgentId: "agent-1" },
    ] as const;

    it("returns all routines when no statuses selected", () => {
      const result = applyRoutineFilters([...routines], { statuses: [] });
      expect(result.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    });

    it("filters to selected display statuses", () => {
      const result = applyRoutineFilters([...routines], { statuses: ["on"] });
      expect(result.map((r) => r.id)).toEqual(["1"]);
    });

    it("supports multi-select inclusion", () => {
      const result = applyRoutineFilters([...routines], { statuses: ["off", "archived"] });
      expect(result.map((r) => r.id)).toEqual(["2", "4"]);
    });
  });

  describe("normalizeRoutineFilterState", () => {
    it("returns defaults for non-objects", () => {
      expect(normalizeRoutineFilterState(null)).toEqual({ statuses: [] });
      expect(normalizeRoutineFilterState(42)).toEqual({ statuses: [] });
    });

    it("drops unknown statuses and duplicates", () => {
      const result = normalizeRoutineFilterState({ statuses: ["on", "bogus", "on", "archived"] });
      expect(result.statuses).toEqual(["on", "archived"]);
    });
  });

  describe("toggleRoutineFilterStatus", () => {
    it("adds when missing and removes when present", () => {
      expect(toggleRoutineFilterStatus([], "on")).toEqual(["on"]);
      expect(toggleRoutineFilterStatus(["on", "off"], "on")).toEqual(["off"]);
    });
  });

  describe("countActiveRoutineFilters", () => {
    it("returns 0 for empty state and 1 otherwise", () => {
      expect(countActiveRoutineFilters({ statuses: [] })).toBe(0);
      expect(countActiveRoutineFilters({ statuses: ["on"] })).toBe(1);
      expect(countActiveRoutineFilters({ statuses: ["on", "off"] })).toBe(1);
    });
  });
});
