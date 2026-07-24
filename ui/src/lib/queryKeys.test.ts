import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("project query keys", () => {
  it("separates default and includeArchived project list caches", () => {
    expect(queryKeys.projects.list("company-1")).toEqual([
      "projects",
      "company-1",
      { includeArchived: false },
    ]);
    expect(queryKeys.projects.list("company-1", { includeArchived: true })).toEqual([
      "projects",
      "company-1",
      { includeArchived: true },
    ]);
    expect(queryKeys.projects.list("company-1")).not.toEqual(
      queryKeys.projects.list("company-1", { includeArchived: true }),
    );
    expect(queryKeys.projects.all("company-1")).toEqual(["projects", "company-1"]);
  });
});
