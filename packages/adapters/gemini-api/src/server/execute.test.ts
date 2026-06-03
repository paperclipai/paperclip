import { describe, expect, it } from "vitest";
import { resolveFallbackChain } from "./execute.js";

const FLASH = "gemini-2.5-flash";
const FLASH_LITE = "gemini-2.5-flash-lite";
const PRO = "gemini-2.5-pro";

describe("resolveFallbackChain — low tier", () => {
  it("pro → flash-lite", () => {
    expect(resolveFallbackChain(PRO, "low")).toEqual([PRO, FLASH_LITE]);
  });

  it("flash → flash-lite", () => {
    expect(resolveFallbackChain(FLASH, "low")).toEqual([FLASH, FLASH_LITE]);
  });

  it("flash-lite stays as flash-lite only", () => {
    expect(resolveFallbackChain(FLASH_LITE, "low")).toEqual([FLASH_LITE]);
  });
});

describe("resolveFallbackChain — medium tier", () => {
  it("pro → flash → flash-lite", () => {
    expect(resolveFallbackChain(PRO, "medium")).toEqual([PRO, FLASH, FLASH_LITE]);
  });

  it("flash → flash-lite", () => {
    expect(resolveFallbackChain(FLASH, "medium")).toEqual([FLASH, FLASH_LITE]);
  });

  it("flash-lite stays as flash-lite only", () => {
    expect(resolveFallbackChain(FLASH_LITE, "medium")).toEqual([FLASH_LITE]);
  });

  it("unknown model → model → flash → flash-lite", () => {
    expect(resolveFallbackChain("gemini-2.0-flash", "medium")).toEqual([
      "gemini-2.0-flash",
      FLASH,
      FLASH_LITE,
    ]);
  });
});

describe("resolveFallbackChain — high tier", () => {
  it("high tier: pro only — refuses fallback", () => {
    expect(resolveFallbackChain(PRO, "high")).toEqual([PRO]);
  });

  it("high tier: flash only — refuses fallback", () => {
    expect(resolveFallbackChain(FLASH, "high")).toEqual([FLASH]);
  });

  it("high tier: flash-lite only — refuses fallback", () => {
    expect(resolveFallbackChain(FLASH_LITE, "high")).toEqual([FLASH_LITE]);
  });
});
