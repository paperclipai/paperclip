import { describe, expect, it } from "vitest";
import { parseStatusFilter } from "../services/issues.js";

describe("parseStatusFilter", () => {
  it("returns [] for missing and empty values", () => {
    expect(parseStatusFilter(undefined)).toEqual([]);
    expect(parseStatusFilter("")).toEqual([]);
    expect(parseStatusFilter(",")).toEqual([]);
  });

  it("supports single and comma-separated status values", () => {
    expect(parseStatusFilter("todo")).toEqual(["todo"]);
    expect(parseStatusFilter("todo,in_progress,done")).toEqual([
      "todo",
      "in_progress",
      "done",
    ]);
  });

  it("supports repeated query key arrays and mixed CSV arrays", () => {
    expect(parseStatusFilter(["todo", "in_progress"])).toEqual(["todo", "in_progress"]);
    expect(parseStatusFilter(["todo,in_progress", "done"])).toEqual([
      "todo",
      "in_progress",
      "done",
    ]);
  });

  it("trims whitespace and does not mutate arrays", () => {
    const input: readonly string[] = [" todo ", "in_progress"];

    expect(parseStatusFilter(input)).toEqual(["todo", "in_progress"]);
    expect(input).toEqual([" todo ", "in_progress"]);
  });
});
