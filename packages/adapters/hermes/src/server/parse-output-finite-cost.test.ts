import { describe, expect, it } from "vitest";

import { parseHermesOutput } from "./execute.js";

describe("parseHermesOutput cost finiteness", () => {
  it("omits costUsd when the matched digits overflow to a non-finite number", () => {
    const parsed = parseHermesOutput(`cost: ${"9".repeat(400)}`, "");
    expect(parsed.costUsd).toBeUndefined();
  });
});
