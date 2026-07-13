import { describe, expect, it } from "vitest";

import { parseHermesOutput } from "./execute.js";

describe("parseHermesOutput", () => {
  it("does not turn successful terminal narration into an adapter error", () => {
    const narration =
      "The live checks are conclusive: JAC-3307 is done. I am closing the incident now.";

    const parsed = parseHermesOutput(
      `${narration}\n\nsession_id: session-1\n`,
      `Captured reasoning: ${narration}\n`,
      false,
    );

    expect(parsed.response).toContain("JAC-3307 is done");
    expect(parsed.errorMessage).toBeUndefined();
  });

  it("retains stderr failure diagnostics for a nonzero process", () => {
    const parsed = parseHermesOutput("", "ERROR: provider unavailable\n", true);

    expect(parsed.errorMessage).toBe("ERROR: provider unavailable");
  });
});
