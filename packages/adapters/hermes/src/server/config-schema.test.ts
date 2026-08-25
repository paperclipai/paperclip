import { describe, expect, it } from "vitest";

import { getConfigSchema } from "./config-schema.js";

describe("Hermes adapter config schema", () => {
  it("exposes profile-scoped MOA bindings as JSON configuration", () => {
    const field = getConfigSchema().fields.find(
      (candidate) => candidate.key === "moaProfileBindings",
    );

    expect(field).toMatchObject({
      key: "moaProfileBindings",
      type: "textarea",
    });
  });
});
