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
    expect(thinkLevelToOpenCodeVariant("auto")).toBeUndefined();
    expect(thinkLevelToOpenCodeVariant("low")).toBe("minimal");
    expect(thinkLevelToOpenCodeVariant("high")).toBe("high");
    expect(thinkLevelToOpenCodeVariant("max")).toBe("max");
  });

  it("reads think level and open code variant from unknown values", () => {
    expect(readThinkLevel("high")).toBe("high");
    expect(readThinkLevel("auto")).toBe("auto");
    expect(readThinkLevel("max")).toBe("max");
    expect(readThinkLevel("off")).toBe("low");
    expect(readThinkLevel("medium")).toBe("high");
    expect(readThinkLevel("invalid")).toBeNull();
    expect(readThinkLevel("")).toBeNull();

    expect(readOpenCodeVariant("max")).toBe("max");
    expect(readOpenCodeVariant("high")).toBe("high");
    expect(readOpenCodeVariant("invalid")).toBeNull();
  });

  it("merges variant into adapter config from think level", () => {
    expect(
      applyThinkVariantToAdapterConfig({
        config: { model: "x/y" },
        thinkLevel: "high",
        openCodeVariant: null,
      }),
    ).toEqual({
      model: "x/y",
      variant: "high",
    });

    expect(
      applyThinkVariantToAdapterConfig({
        config: { model: "x/y", variant: "max" },
        thinkLevel: "auto",
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
      payload: { thinkLevel: "max", openCodeVariant: "max" },
    });

    expect(contextSnapshot).toMatchObject({
      thinkLevel: "max",
      openCodeVariant: "max",
    });
  });

  it("does not overwrite existing context think fields", () => {
    const contextSnapshot = normalizeThinkVariantWakeContext({
      contextSnapshot: { thinkLevel: "low", openCodeVariant: "low" },
      payload: { thinkLevel: "max", openCodeVariant: "xhigh" },
    });

    expect(contextSnapshot).toMatchObject({
      thinkLevel: "low",
      openCodeVariant: "low",
    });
  });

  it("persists auto without openCodeVariant from payload", () => {
    const contextSnapshot = normalizeThinkVariantWakeContext({
      contextSnapshot: {},
      payload: { thinkLevel: "auto" },
    });

    expect(contextSnapshot).toMatchObject({ thinkLevel: "auto" });
    expect(contextSnapshot.openCodeVariant).toBeUndefined();
  });
});
