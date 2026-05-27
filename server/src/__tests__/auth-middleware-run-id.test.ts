import { describe, expect, it } from "vitest";
import { normalizeActorRunId } from "../middleware/auth.js";

describe("normalizeActorRunId", () => {
  it("keeps valid UUID run ids", () => {
    expect(normalizeActorRunId("9dae664c-7dae-4a1c-860b-c83657e34422")).toBe(
      "9dae664c-7dae-4a1c-860b-c83657e34422",
    );
  });

  it("drops non-UUID run ids before they reach database UUID columns", () => {
    expect(normalizeActorRunId("manual-auth-smoke-20260526")).toBeUndefined();
  });
});
