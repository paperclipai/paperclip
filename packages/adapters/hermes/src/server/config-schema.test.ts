import { describe, expect, it } from "vitest";

import { getConfigSchema } from "./config-schema.js";

describe("Hermes adapter config schema", () => {
  it("exposes structured result records as an explicit opt-in", () => {
    const field = getConfigSchema().fields.find((candidate) => candidate.key === "emitResultRecord");

    expect(field).toMatchObject({
      type: "toggle",
      default: false,
    });
    expect(field?.hint).toContain("--emit-result-record");
  });
});
