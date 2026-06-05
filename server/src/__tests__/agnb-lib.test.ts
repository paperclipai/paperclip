import { describe, expect, it } from "vitest";
import { pgTextArray } from "../agnb/helpers.js";
import { parseRating } from "../agnb/lib/serpapi.js";

describe("pgTextArray", () => {
  it("builds a Postgres array literal", () => {
    expect(pgTextArray(["a", "b", "c"])).toBe('{"a","b","c"}');
  });
  it("escapes quotes and backslashes", () => {
    expect(pgTextArray(['he said "hi"', "back\\slash"])).toBe('{"he said \\"hi\\"","back\\\\slash"}');
  });
  it("handles an empty array", () => {
    expect(pgTextArray([])).toBe("{}");
  });
});

describe("serpapi parseRating", () => {
  it("prefers the knowledge graph rating", () => {
    const data = { knowledge_graph: { rating: 4.7, reviews: 132 } };
    expect(parseRating(data, "g2.com")).toEqual({ rating: 4.7, reviews: 132 });
  });

  it("falls back to an organic rich snippet on the platform domain", () => {
    const data = {
      organic_results: [
        { link: "https://example.com/x", rich_snippet: { top: { detected_extensions: { rating: 3.1, reviews: 9 } } } },
        { link: "https://www.g2.com/products/finn/reviews", rich_snippet: { top: { detected_extensions: { rating: 4.5, reviews: 88 } } } },
      ],
    };
    expect(parseRating(data, "g2.com")).toEqual({ rating: 4.5, reviews: 88 });
  });

  it("uses any organic rich snippet when none match the domain", () => {
    const data = {
      organic_results: [
        { link: "https://other.com/x", rich_snippet: { bottom: { detected_extensions: { rating: 4.2, votes: 20 } } } },
      ],
    };
    expect(parseRating(data, "g2.com")).toEqual({ rating: 4.2, reviews: 20 });
  });

  it("returns nulls when no rating is present", () => {
    expect(parseRating({ organic_results: [{ link: "https://g2.com/x" }] }, "g2.com")).toEqual({ rating: null, reviews: null });
  });

  it("coerces dirty numeric strings", () => {
    const data = { knowledge_graph: { rating: "4.6", reviews: "1,204 reviews" } };
    expect(parseRating(data, "")).toEqual({ rating: 4.6, reviews: 1204 });
  });
});
