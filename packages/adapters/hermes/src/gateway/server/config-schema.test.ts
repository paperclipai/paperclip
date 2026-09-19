import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("gateway result handoff configuration", () => {
  it("advertises review submission as an explicit opt-in, not automatic completion", () => {
    const field = getConfigSchema().fields.find((candidate) => candidate.key === "resultHandoff");
    expect(field).toMatchObject({
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "Worker manages disposition" },
        { value: "review", label: "Submit result to configured reviewer" },
      ],
    });
  });
});
