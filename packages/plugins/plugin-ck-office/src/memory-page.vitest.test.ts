import { describe, expect, it } from "vitest";
import { normalizeMemoryPageParams } from "./memory-page.js";

describe("CK Memory page bounds", () => {
  it("defaults to the bounded needs-review page", () => {
    expect(normalizeMemoryPageParams(undefined)).toEqual({
      filter: "needs_review",
      query: "",
      page: 1,
      pageSize: 25,
      offset: 0,
    });
  });

  it("clamps untrusted page parameters and search length", () => {
    const result = normalizeMemoryPageParams({
      filter: "unexpected",
      query: `  ${"x".repeat(150)}  `,
      page: -8,
      pageSize: 500,
    });

    expect(result.filter).toBe("needs_review");
    expect(result.query).toHaveLength(120);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("computes a stable offset for explicit filters", () => {
    expect(
      normalizeMemoryPageParams({
        filter: "verified",
        query: "  venue  ",
        page: 3,
        pageSize: 10,
      }),
    ).toEqual({
      filter: "verified",
      query: "venue",
      page: 3,
      pageSize: 10,
      offset: 20,
    });
  });
});
