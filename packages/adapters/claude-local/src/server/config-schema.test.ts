import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("Claude adapter configuration", () => {
  it("uses the shared 400K normal-run token budget by default", () => {
    const field = getConfigSchema().fields.find(
      (candidate) => candidate.key === "maxTokensPerRun",
    );
    expect(field?.default).toBe(400_000);
  });
});
