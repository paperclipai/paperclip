import { describe, expect, it } from "vitest";
import { normalizeDepartmentName } from "./department.js";

describe("normalizeDepartmentName", () => {
  it("collapses surrounding and repeated whitespace", () => {
    expect(normalizeDepartmentName("  Accounting   team  ")).toBe("Accounting team");
  });

  it("rejects an empty name and a name past the stored limit", () => {
    expect(normalizeDepartmentName("   ")).toBeNull();
    expect(normalizeDepartmentName("a".repeat(81))).toBeNull();
  });
});
