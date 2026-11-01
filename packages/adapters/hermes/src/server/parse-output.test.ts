import { describe, expect, it } from "vitest";

import { parseHermesOutput } from "./execute.js";

describe("parseHermesOutput cost extraction", () => {
  it("omits costUsd when prose mentions spending without a number", () => {
    const parsed = parseHermesOutput("No code, nothing spent.", "");
    expect(parsed.costUsd).toBeUndefined();
  });

  it("parses a numeric cost", () => {
    const parsed = parseHermesOutput("cost: $0.25", "");
    expect(parsed.costUsd).toBe(0.25);
  });
});
