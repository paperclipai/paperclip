import { describe, expect, it } from "vitest";
import {
  applyThinkVariantToAdapterConfig,
  normalizeThinkVariantWakeContext,
  readOpenCodeVariant,
  readThinkLevel,
  thinkLevelToOpenCodeVariant,
} from "../services/heartbeat.ts";

describe("heartbeat think variant", () => {
  it("maps think levels to OpenCode variants", () => {
    expect(thinkLevelToOpenCodeVariant("off")).toBeUndefined();
    expect(thinkLevelToOpenCodeVariant("low")).toBe("low");
    expect(thinkLevelToOpenCodeVariant("medium")).toBe("medium");
    expect(thinkLevelToOpenCodeVariant("high")).toBe("high");
  });

  it("reads think level and open code variant from unknown values", () => {
    expect(readThinkLevel("medium")).toBe("medium");
    expect(readThinkLevel("off")).toBe("off");
    expect(readThinkLevel("invalid")).toBeNull();
    expect(readThinkLevel("")).toBeNull();

    expect(readOpenCodeVariant("xhigh")).toBe("xhigh");
    expect(readOpenCodeVariant("high")).toBe("high");
    expect(readOpenCodeVariant("invalid")).toBeNull();
  });

  it("merges variant into adapter config from think level", () => {
    expect(
      applyThinkVariantToAdapterConfig({
        config: { model: "x/y" },
        thinkLevel: "medium",
        openCodeVariant: null,
      }),
    ).toEqual({
      model: "x/y",
      variant: "medium",
    });

    expect(
      applyThinkVariantToAdapterConfig({
        config: { model: "x/y", variant: "high" },
        thinkLevel: "off",
        openCodeVariant: null,
      }),
    ).toEqual({
      model: "x/y",
    });
  });

  it("prefers explicit openCodeVariant over thinkLevel mapping", () => {
    expect(
      applyThinkVariantToAdapterConfig({
        config: { model: "x/y" },
        thinkLevel: "low",
        openCodeVariant: "xhigh",
      }),
    ).toEqual({
      model: "x/y",
      variant: "xhigh",
    });
  });

  it("normalizes wake payload think fields into run context", () => {
    const contextSnapshot = normalizeThinkVariantWakeContext({
      contextSnapshot: {},
      payload: { thinkLevel: "high", openCodeVariant: "high" },
    });

    expect(contextSnapshot).toMatchObject({
      thinkLevel: "high",
      openCodeVariant: "high",
    });
  });

  it("does not overwrite existing context think fields", () => {
    const contextSnapshot = normalizeThinkVariantWakeContext({
      contextSnapshot: { thinkLevel: "low", openCodeVariant: "low" },
      payload: { thinkLevel: "high", openCodeVariant: "xhigh" },
    });

    expect(contextSnapshot).toMatchObject({
      thinkLevel: "low",
      openCodeVariant: "low",
    });
  });

  it("persists thinkLevel off without openCodeVariant from payload", () => {
    const contextSnapshot = normalizeThinkVariantWakeContext({
      contextSnapshot: {},
      payload: { thinkLevel: "off" },
    });

    expect(contextSnapshot).toMatchObject({ thinkLevel: "off" });
    expect(contextSnapshot.openCodeVariant).toBeUndefined();
  });
});
