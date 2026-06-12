import { describe, expect, it } from "vitest";
import { getNextRunsPageOffset, RUNS_PAGE_SIZE } from "./AgentDetail";

describe("getNextRunsPageOffset", () => {
  it("advances by a page when a full page was returned", () => {
    expect(getNextRunsPageOffset(RUNS_PAGE_SIZE, 0)).toBe(RUNS_PAGE_SIZE);
    expect(getNextRunsPageOffset(RUNS_PAGE_SIZE, RUNS_PAGE_SIZE)).toBe(RUNS_PAGE_SIZE * 2);
    expect(getNextRunsPageOffset(1000, 2000, 1000)).toBe(3000);
  });

  it("stops paging once a short page signals the end of the list", () => {
    expect(getNextRunsPageOffset(RUNS_PAGE_SIZE - 1, 0)).toBeUndefined();
    expect(getNextRunsPageOffset(0, RUNS_PAGE_SIZE)).toBeUndefined();
    expect(getNextRunsPageOffset(999, 2000, 1000)).toBeUndefined();
  });
});
