import { describe, expect, it } from "vitest";
import { buildDevinEffortOptions } from "./effort-options";

describe("buildDevinEffortOptions", () => {
  it("offers only the selected family's tiers plus Auto", () => {
    expect(buildDevinEffortOptions(["auto", "medium"], "")).toEqual([
      { id: "", label: "Auto" },
      { id: "medium", label: "Medium" },
    ]);
    expect(buildDevinEffortOptions(["auto", "low", "high", "max"], "")).toEqual([
      { id: "", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ]);
  });

  it("offers Auto only when the catalog has no effort data for the model", () => {
    expect(buildDevinEffortOptions(undefined, "")).toEqual([{ id: "", label: "Auto" }]);
    expect(buildDevinEffortOptions([], "")).toEqual([{ id: "", label: "Auto" }]);
  });

  it("keeps a stored value visible and flagged when the family does not offer it", () => {
    const options = buildDevinEffortOptions(["auto", "medium"], "max");
    expect(options).toEqual([
      { id: "", label: "Auto" },
      { id: "medium", label: "Medium" },
      { id: "max", label: "Max (not available for this model)" },
    ]);
  });

  it("falls back to the raw tier id when no display label is known", () => {
    expect(buildDevinEffortOptions(["auto", "ultra"], "")).toEqual([
      { id: "", label: "Auto" },
      { id: "ultra", label: "ultra" },
    ]);
  });
});
