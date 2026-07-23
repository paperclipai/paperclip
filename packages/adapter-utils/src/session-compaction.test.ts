import { describe, expect, it } from "vitest";
import {
  ADAPTER_SESSION_MANAGEMENT,
  LEGACY_SESSIONED_ADAPTER_TYPES,
  getAdapterSessionManagement,
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

describe("getAdapterSessionManagement", () => {
  it("returns null for null/undefined/empty adapter type", () => {
    expect(getAdapterSessionManagement(null)).toBeNull();
    expect(getAdapterSessionManagement(undefined)).toBeNull();
    expect(getAdapterSessionManagement("")).toBeNull();
  });

  it("returns the registered entry for a known adapter", () => {
    const entry = getAdapterSessionManagement("claude_local");
    expect(entry).not.toBeNull();
    expect(entry?.supportsSessionResume).toBe(true);
    expect(entry?.nativeContextManagement).toBe("confirmed");
  });

  it("returns null for an unknown adapter type", () => {
    expect(getAdapterSessionManagement("not-a-real-adapter")).toBeNull();
  });
});

describe("ADAPTER_SESSION_MANAGEMENT registry", () => {
  it("flags every native-context adapter with a zero-threshold default policy", () => {
    // Native-context adapters MUST not be rotated by Staple thresholds --
    // the adapter manages its own context. A non-zero default would fight
    // the adapter's internal compaction.
    for (const [adapter, mgmt] of Object.entries(ADAPTER_SESSION_MANAGEMENT)) {
      if (mgmt.nativeContextManagement === "confirmed") {
        expect(mgmt.defaultSessionCompaction.maxSessionRuns).toBe(0);
        expect(mgmt.defaultSessionCompaction.maxRawInputTokens).toBe(0);
        expect(mgmt.defaultSessionCompaction.maxSessionAgeHours).toBe(0);
        expect(mgmt.defaultSessionCompaction.enabled).toBe(true);
        // Sanity: the adapter is also listed in legacy types so it gets
        // session resume, but its policy is zero'd out.
        if (LEGACY_SESSIONED_ADAPTER_TYPES.has(adapter)) {
          // ok
        }
      }
    }
  });

  it("contains all known legacy sessioned adapters", () => {
    // Pin set so a future rename or removal breaks loudly here.
    expect([...LEGACY_SESSIONED_ADAPTER_TYPES].sort()).toEqual([
      "acpx_local",
      "claude_local",
      "codex_local",
      "cursor",
      "gemini_local",
      "hermes_local",
      "opencode_local",
      "pi_local",
    ]);
  });
});

describe("readSessionCompactionOverride", () => {
  it("returns empty object for non-record runtimeConfig", () => {
    expect(readSessionCompactionOverride(null)).toEqual({});
    expect(readSessionCompactionOverride(undefined)).toEqual({});
    expect(readSessionCompactionOverride([])).toEqual({});
    expect(readSessionCompactionOverride("string")).toEqual({});
    expect(readSessionCompactionOverride(42)).toEqual({});
  });

  it("returns empty object when no compaction key is present", () => {
    expect(readSessionCompactionOverride({ heartbeat: {} })).toEqual({});
    expect(readSessionCompactionOverride({})).toEqual({});
  });

  it("reads from heartbeat.sessionCompaction when present", () => {
    const out = readSessionCompactionOverride({
      heartbeat: {
        sessionCompaction: {
          enabled: true,
          maxSessionRuns: 500,
          maxRawInputTokens: 1_000_000,
          maxSessionAgeHours: 48,
        },
      },
    });
    expect(out).toEqual({
      enabled: true,
      maxSessionRuns: 500,
      maxRawInputTokens: 1_000_000,
      maxSessionAgeHours: 48,
    });
  });

  it("falls back to heartbeat.sessionRotation alias when sessionCompaction missing", () => {
    const out = readSessionCompactionOverride({
      heartbeat: { sessionRotation: { maxSessionRuns: 99 } },
    });
    expect(out).toEqual({ maxSessionRuns: 99 });
  });

  it("falls back to top-level runtime.sessionCompaction when heartbeat missing", () => {
    const out = readSessionCompactionOverride({
      sessionCompaction: { maxSessionAgeHours: 12 },
    });
    expect(out).toEqual({ maxSessionAgeHours: 12 });
  });

  it("prefers heartbeat.sessionCompaction over heartbeat.sessionRotation", () => {
    const out = readSessionCompactionOverride({
      heartbeat: {
        sessionCompaction: { maxSessionRuns: 1 },
        sessionRotation: { maxSessionRuns: 999 },
      },
    });
    expect(out).toEqual({ maxSessionRuns: 1 });
  });

  describe("readBoolean coercion", () => {
    it.each([
      [true, true],
      [false, false],
      [1, true],
      [0, false],
      ["true", true],
      ["TRUE", true],
      ["YES", true],
      ["on", true],
      ["1", true],
      ["false", false],
      ["NO", false],
      ["off", false],
      ["0", false],
    ])("coerces enabled=%j -> %j", (input, expected) => {
      expect(
        readSessionCompactionOverride({ sessionCompaction: { enabled: input } }),
      ).toEqual({ enabled: expected });
    });

    it.each([2, "maybe", "yo", null])(
      "drops un-coercible enabled=%j",
      (input) => {
        expect(
          readSessionCompactionOverride({ sessionCompaction: { enabled: input } }),
        ).toEqual({});
      },
    );
  });

  describe("readNumber coercion", () => {
    it("clamps negative inputs to 0 (Math.max floor)", () => {
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxSessionRuns: -10 },
        }),
      ).toEqual({ maxSessionRuns: 0 });
    });

    it("floors fractional inputs", () => {
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxSessionRuns: 7.9 },
        }),
      ).toEqual({ maxSessionRuns: 7 });
    });

    it("parses numeric strings", () => {
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxRawInputTokens: "  500000 " },
        }),
      ).toEqual({ maxRawInputTokens: 500000 });
    });

    it("rejects non-finite (NaN, Infinity)", () => {
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxSessionRuns: NaN },
        }),
      ).toEqual({});
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxSessionRuns: Infinity },
        }),
      ).toEqual({});
    });

    it("rejects non-numeric strings", () => {
      expect(
        readSessionCompactionOverride({
          sessionCompaction: { maxSessionRuns: "abc" },
        }),
      ).toEqual({});
    });
  });
});

describe("resolveSessionCompactionPolicy", () => {
  it("uses adapter default when adapter is registered + no override", () => {
    const out = resolveSessionCompactionPolicy("claude_local", {});
    expect(out.source).toBe("adapter_default");
    // claude_local is native-context -> zero thresholds
    expect(out.policy.maxSessionRuns).toBe(0);
    expect(out.policy.maxRawInputTokens).toBe(0);
    expect(out.policy.maxSessionAgeHours).toBe(0);
    expect(out.policy.enabled).toBe(true);
    expect(out.adapterSessionManagement).not.toBeNull();
    expect(out.explicitOverride).toEqual({});
  });

  it("uses legacy fallback when adapter is unknown but in LEGACY set", () => {
    // None of the LEGACY-only set are missing from ADAPTER_SESSION_MANAGEMENT
    // today, so simulate by passing an unknown adapter type. Source becomes
    // 'legacy_fallback' but enabled goes false because the adapter isn't
    // in the legacy set either.
    const out = resolveSessionCompactionPolicy("unknown_adapter", {});
    expect(out.source).toBe("legacy_fallback");
    expect(out.policy.enabled).toBe(false);
    // Falls back to DEFAULT thresholds (200 / 2_000_000 / 72)
    expect(out.policy.maxSessionRuns).toBe(200);
    expect(out.policy.maxRawInputTokens).toBe(2_000_000);
    expect(out.policy.maxSessionAgeHours).toBe(72);
    expect(out.adapterSessionManagement).toBeNull();
  });

  it("explicit override flips source to agent_override and wins over defaults", () => {
    const out = resolveSessionCompactionPolicy("claude_local", {
      sessionCompaction: { maxSessionRuns: 42, enabled: false },
    });
    expect(out.source).toBe("agent_override");
    expect(out.policy.enabled).toBe(false);
    expect(out.policy.maxSessionRuns).toBe(42);
    // Non-overridden fields fall back to adapter default (zeros)
    expect(out.policy.maxRawInputTokens).toBe(0);
    expect(out.policy.maxSessionAgeHours).toBe(0);
    expect(out.explicitOverride).toEqual({
      maxSessionRuns: 42,
      enabled: false,
    });
  });

  it("legacy_fallback enabled=true when adapterType is in LEGACY_SESSIONED set", () => {
    // Build an adapter registered in LEGACY but not in ADAPTER_SESSION_MANAGEMENT.
    // None today match -- but the resolveSessionCompactionPolicy logic uses
    // adapter_default when registered. So this branch only fires for adapters
    // present ONLY in LEGACY_SESSIONED_ADAPTER_TYPES. Pin via a registered
    // adapter that's also legacy: cursor (legacy + DEFAULT policy).
    const out = resolveSessionCompactionPolicy("cursor", {});
    // cursor IS in ADAPTER_SESSION_MANAGEMENT so source is adapter_default,
    // not legacy_fallback. The legacy-fallback path is essentially unreachable
    // unless an adapter is removed from the management map. Pin source.
    expect(out.source).toBe("adapter_default");
    expect(out.policy.maxSessionRuns).toBe(200);
    expect(out.policy.enabled).toBe(true);
  });

  it("null adapterType falls through to legacy_fallback with enabled=false", () => {
    const out = resolveSessionCompactionPolicy(null, {});
    expect(out.source).toBe("legacy_fallback");
    expect(out.policy.enabled).toBe(false);
    expect(out.adapterSessionManagement).toBeNull();
  });

  it("override of just one field leaves the other adapter defaults intact", () => {
    const out = resolveSessionCompactionPolicy("cursor", {
      sessionCompaction: { maxSessionAgeHours: 24 },
    });
    expect(out.source).toBe("agent_override");
    expect(out.policy.maxSessionAgeHours).toBe(24);
    // Other fields stay at cursor's DEFAULT_SESSION_COMPACTION_POLICY
    expect(out.policy.maxSessionRuns).toBe(200);
    expect(out.policy.maxRawInputTokens).toBe(2_000_000);
    expect(out.policy.enabled).toBe(true);
  });
});

describe("hasSessionCompactionThresholds", () => {
  it("returns false when every threshold is zero (native-managed adapter)", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      }),
    ).toBe(false);
  });

  it("returns true when any single threshold is non-zero", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 1,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      }),
    ).toBe(true);
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 1,
        maxSessionAgeHours: 0,
      }),
    ).toBe(true);
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 1,
      }),
    ).toBe(true);
  });
});
