import { describe, expect, it } from "vitest";
import { wakeAgentSchema } from "@paperclipai/shared";
import { normalizeModelProfileWakeContext } from "../services/heartbeat.js";

// E4 model tiering: a wake may carry an explicit model-tier override that the
// heartbeat applies for the run. These cover the two ends of that wire — the
// validator accepting the field, and the context normalizer surfacing it.

describe("wakeAgentSchema modelProfile (E4)", () => {
  it("accepts a known model profile", () => {
    const parsed = wakeAgentSchema.parse({ modelProfile: "cheap" });
    expect(parsed.modelProfile).toBe("cheap");
  });

  it("omitting modelProfile is fine", () => {
    const parsed = wakeAgentSchema.parse({});
    expect(parsed.modelProfile ?? null).toBeNull();
  });

  it("rejects an unknown model profile", () => {
    expect(() => wakeAgentSchema.parse({ modelProfile: "premium" })).toThrow();
  });
});

describe("normalizeModelProfileWakeContext (E4)", () => {
  it("keeps an explicit contextSnapshot.modelProfile (the wake-route path)", () => {
    const snapshot = normalizeModelProfileWakeContext({
      contextSnapshot: { modelProfile: "cheap" },
      payload: null,
    });
    expect(snapshot.modelProfile).toBe("cheap");
  });

  it("falls back to payload.modelProfile when the snapshot has none", () => {
    const snapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });
    expect(snapshot.modelProfile).toBe("cheap");
  });

  it("leaves the snapshot untouched when neither carries a profile", () => {
    const snapshot = normalizeModelProfileWakeContext({ contextSnapshot: {}, payload: null });
    expect(snapshot.modelProfile).toBeUndefined();
  });
});
