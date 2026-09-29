import { describe, expect, it } from "vitest";

import {
  isProviderGenerationSuccessor,
  isProviderProcessGeneration,
  provesProviderGenerationTransition,
} from "./process-generation.js";

const maxLegacy = Number.MAX_SAFE_INTEGER;
const firstOpaque = "p:00000000-0000-4000-8000-000000000001";
const nextOpaque = "p:00000000-0000-4000-8000-000000000002";
const launchId = "00000000-0000-4000-8000-000000000010";

describe("provider process generation", () => {
  it("switches from the exact legacy ceiling to distinct opaque lifetimes", () => {
    expect(isProviderProcessGeneration(maxLegacy)).toBe(true);
    expect(isProviderProcessGeneration(firstOpaque)).toBe(true);
    expect(isProviderGenerationSuccessor(maxLegacy - 1, maxLegacy)).toBe(true);
    expect(isProviderGenerationSuccessor(maxLegacy, firstOpaque)).toBe(true);
    expect(isProviderGenerationSuccessor(firstOpaque, nextOpaque)).toBe(true);
    expect(isProviderGenerationSuccessor(firstOpaque, firstOpaque)).toBe(false);
    expect(isProviderGenerationSuccessor(firstOpaque, 1)).toBe(false);
    expect(isProviderGenerationSuccessor(maxLegacy, 1)).toBe(false);
  });

  it("requires a canonical opaque UUID token and exact launch transition", () => {
    for (const malformed of [
      "p:00000000-0000-0000-8000-000000000001",
      "p:00000000-0000-4000-7000-000000000001",
      "p:00000000-0000-4000-8000-00000000000Z",
      "p:00000000-0000-4000-8000-000000000001 ",
    ]) {
      expect(isProviderProcessGeneration(malformed)).toBe(false);
      expect(isProviderGenerationSuccessor(maxLegacy, malformed)).toBe(false);
    }

    const transition = { from: maxLegacy, to: firstOpaque, launchId };
    expect(provesProviderGenerationTransition(maxLegacy, firstOpaque, transition)).toBe(true);
    expect(provesProviderGenerationTransition(maxLegacy - 1, firstOpaque, transition)).toBe(false);
    expect(provesProviderGenerationTransition(maxLegacy, nextOpaque, transition)).toBe(false);
    expect(provesProviderGenerationTransition(maxLegacy, firstOpaque, { ...transition, launchId: "bad" })).toBe(false);
    expect(provesProviderGenerationTransition(maxLegacy, firstOpaque, { ...transition, extra: true })).toBe(false);
    expect(provesProviderGenerationTransition(firstOpaque, 1, { from: firstOpaque, to: 1, launchId })).toBe(false);
  });
});
