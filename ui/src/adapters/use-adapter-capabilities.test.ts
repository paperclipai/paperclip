import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTER_CAPABILITY_DEFAULTS } from "./use-adapter-capabilities";

describe("BUILTIN_ADAPTER_CAPABILITY_DEFAULTS", () => {
  it("exposes Hermes local managed instructions support before adapter API data loads", () => {
    expect(BUILTIN_ADAPTER_CAPABILITY_DEFAULTS.hermes_local).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      supportsModelProfiles: false,
      supportsAcp: false,
    });
  });
});
