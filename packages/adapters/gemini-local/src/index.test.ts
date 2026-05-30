import { describe, expect, it } from "vitest";
import { models, DEFAULT_GEMINI_LOCAL_MODEL } from "./index.js";

describe("gemini-local model catalog", () => {
  const modelIds = models.map((m) => m.id);

  it("includes Gemini 3.x models verified via direct API", () => {
    expect(modelIds).toContain("gemini-3.5-flash");
    expect(modelIds).toContain("gemini-3.1-pro-preview");
    expect(modelIds).toContain("gemini-3.1-flash-lite");
    expect(modelIds).toContain("gemini-3-flash-preview");
  });

  it("includes Gemini 2.5.x models for backward compatibility", () => {
    expect(modelIds).toContain("gemini-2.5-pro");
    expect(modelIds).toContain("gemini-2.5-flash");
    expect(modelIds).toContain("gemini-2.5-flash-lite");
  });

  it("retains Gemini 2.0.x models with deprecation label for existing agent compatibility", () => {
    const flash20 = models.find((m) => m.id === "gemini-2.0-flash");
    const flashLite20 = models.find((m) => m.id === "gemini-2.0-flash-lite");
    expect(flash20).toBeDefined();
    expect(flashLite20).toBeDefined();
    expect(flash20?.label.toLowerCase()).toContain("not recommended");
    expect(flashLite20?.label.toLowerCase()).toContain("not recommended");
  });

  it("includes the auto default model", () => {
    expect(modelIds).toContain(DEFAULT_GEMINI_LOCAL_MODEL);
  });

  it("has no duplicate model IDs", () => {
    const unique = new Set(modelIds);
    expect(unique.size).toBe(modelIds.length);
  });

  it("lists Gemini 3.x models before Gemini 2.x models", () => {
    const g3Index = modelIds.findIndex((id) => id.startsWith("gemini-3"));
    const g25Index = modelIds.findIndex((id) => id.startsWith("gemini-2.5"));
    const g20Index = modelIds.findIndex((id) => id.startsWith("gemini-2.0"));
    expect(g3Index).toBeGreaterThan(0);
    expect(g3Index).toBeLessThan(g25Index);
    expect(g25Index).toBeLessThan(g20Index);
  });
});
