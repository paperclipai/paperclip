import { describe, expect, it } from "vitest";
import { findExternalObjectUrlMatches } from "./external-objects-server.js";

describe("external object URL matches", () => {
  it("trims long unmatched bracket suffixes promptly", () => {
    const url = "https://x.test/path?q=[value]";
    const startedAt = performance.now();
    expect(findExternalObjectUrlMatches(url + "]".repeat(160_000) + ".!")).toEqual([
      { index: 0, length: url.length, matchedText: url },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });
});
