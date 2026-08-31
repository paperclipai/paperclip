import { describe, expect, it } from "vitest";
import {
  FALLBACK_SOURCE_CONTEXT_KEY,
  type FallbackSourceSpec,
  applyFallbackSourceToConfig,
  isSourceExhaustionFailure,
  readFallbackChain,
  readFallbackSourceOverride,
  selectNextFallbackSource,
} from "../services/intelligence-fallback.ts";

const claudeAlt: FallbackSourceSpec = {
  adapterType: "claude_local",
  env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "second-sub" } },
  label: "Claude sub #2",
};
const codex: FallbackSourceSpec = { adapterType: "codex_local", label: "Codex" };

describe("isSourceExhaustionFailure", () => {
  it("triggers only on provider quota / rate-limit exhaustion", () => {
    expect(isSourceExhaustionFailure({ errorCode: "provider_quota", errorFamily: null })).toBe(true);
    expect(isSourceExhaustionFailure({ errorCode: "adapter_failed", errorFamily: "provider_quota" })).toBe(true);
  });

  it("never treats a real failure or a budget cap as source exhaustion", () => {
    // Budget exhaustion is a deliberate spend cap, not a source problem.
    expect(isSourceExhaustionFailure({ errorCode: "budget_exhausted", errorFamily: null })).toBe(false);
    expect(isSourceExhaustionFailure({ errorCode: "adapter_failed", errorFamily: null })).toBe(false);
    expect(isSourceExhaustionFailure({ errorCode: null, errorFamily: null })).toBe(false);
  });
});

describe("selectNextFallbackSource", () => {
  it("returns the first same-provider fallback after the default source runs", () => {
    const next = selectNextFallbackSource([claudeAlt, codex], 0, "claude_local");
    expect(next).toMatchObject({ index: 1, adapterType: "claude_local", label: "Claude sub #2" });
  });

  it("skips a deferred cross-provider entry to reach a later same-provider source", () => {
    // Chain orders Codex (cross-provider, not runnable yet) BEFORE a second Claude
    // subscription. Selection must jump past Codex to the reachable Claude sub at
    // index 2 rather than stalling on the unsupported entry.
    const next = selectNextFallbackSource([codex, claudeAlt], 0, "claude_local");
    expect(next).toMatchObject({ index: 2, adapterType: "claude_local", label: "Claude sub #2" });
  });

  it("returns null when only cross-provider entries remain", () => {
    // Codex-only chain from a Claude agent: nothing runnable, so the normal quota
    // wait is left in place instead of a bogus switch.
    expect(selectNextFallbackSource([codex], 0, "claude_local")).toBeNull();
  });

  it("returns null once the same-provider sources are exhausted", () => {
    expect(selectNextFallbackSource([claudeAlt], 1, "claude_local")).toBeNull();
    expect(selectNextFallbackSource([], 0, "claude_local")).toBeNull();
  });
});

describe("readFallbackChain", () => {
  it("reads a valid chain from runtimeConfig", () => {
    const chain = readFallbackChain({ fallbackChain: [claudeAlt, codex] });
    expect(chain).toHaveLength(2);
    expect(chain[1].adapterType).toBe("codex_local");
  });

  it("caps the chain length defensively", () => {
    const many = Array.from({ length: 9 }, () => ({ adapterType: "codex_local" }));
    expect(readFallbackChain({ fallbackChain: many })).toHaveLength(4);
  });

  it("returns an empty chain for missing or malformed config", () => {
    expect(readFallbackChain(undefined)).toEqual([]);
    expect(readFallbackChain({})).toEqual([]);
    expect(readFallbackChain({ fallbackChain: "nope" })).toEqual([]);
    // Entries without an adapterType are dropped.
    expect(readFallbackChain({ fallbackChain: [{ model: "gpt" }, null, 42] })).toEqual([]);
  });
});

describe("applyFallbackSourceToConfig", () => {
  const base = {
    model: "sonnet",
    env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sub1" }, KEEP: { type: "plain", value: "x" } },
  };

  it("swaps the token while inheriting the rest of the env", () => {
    const override = {
      index: 1,
      adapterType: "claude_local",
      env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sub2" } },
    };
    const out = applyFallbackSourceToConfig(base, override, "claude_local");
    expect(out.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sub2" },
      KEEP: { type: "plain", value: "x" },
    });
    expect(out.model).toBe("sonnet"); // untouched when override omits it
  });

  it("overrides model/effort when the source specifies them", () => {
    const out = applyFallbackSourceToConfig(base, { index: 1, adapterType: "claude_local", model: "opus", effort: "high" }, "claude_local");
    expect(out.model).toBe("opus");
    expect(out.effort).toBe("high");
  });

  it("leaves the config untouched with no override or a cross-adapter override", () => {
    expect(applyFallbackSourceToConfig(base, null, "claude_local")).toBe(base);
    // Cross-provider fallback is not applied via config overlay.
    expect(applyFallbackSourceToConfig(base, { index: 1, adapterType: "codex_local" }, "claude_local")).toBe(base);
  });
});

describe("readFallbackSourceOverride", () => {
  it("round-trips a persisted override off a run context snapshot", () => {
    const override = { index: 1, adapterType: "codex_local", model: "gpt", env: { A: 1 }, label: "Codex" };
    const snapshot = { issueId: "x", [FALLBACK_SOURCE_CONTEXT_KEY]: override };
    expect(readFallbackSourceOverride(snapshot)).toEqual(override);
  });

  it("ignores absent or invalid overrides", () => {
    expect(readFallbackSourceOverride({ issueId: "x" })).toBeNull();
    expect(readFallbackSourceOverride(null)).toBeNull();
    // index 0 is the default source, never a valid override.
    expect(readFallbackSourceOverride({ [FALLBACK_SOURCE_CONTEXT_KEY]: { index: 0, adapterType: "codex_local" } })).toBeNull();
    expect(readFallbackSourceOverride({ [FALLBACK_SOURCE_CONTEXT_KEY]: { index: 1 } })).toBeNull();
  });
});
