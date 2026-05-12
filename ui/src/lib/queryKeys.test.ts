import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("queryKeys.approvals.list", () => {
  it("omits absent filters so broad invalidations match filtered approval lists", () => {
    expect(queryKeys.approvals.list("company-1")).toEqual(["approvals", "company-1"]);
    expect(queryKeys.approvals.list("company-1", "pending")).toEqual(["approvals", "company-1", "pending"]);
    expect(queryKeys.approvals.list("company-1", undefined, "plugin-1")).toEqual([
      "approvals",
      "company-1",
      "plugin-1",
    ]);
  });
});
