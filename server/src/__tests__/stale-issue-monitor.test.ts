import { describe, expect, it } from "vitest";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { computeIdleHours, idleThresholdHours } from "../services/stale-issue-monitor.js";

describe("stale-issue-monitor helpers", () => {
  it("computes idle hours from updatedAt", () => {
    const now = new Date("2026-03-30T12:00:00.000Z");
    const updated = new Date("2026-03-29T12:00:00.000Z");
    expect(computeIdleHours(updated, now)).toBe(24);
  });

  it("selects threshold by priority", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});
    expect(idleThresholdHours("critical", settings)).toBe(24);
    expect(idleThresholdHours("high", settings)).toBe(48);
    expect(idleThresholdHours("medium", settings)).toBe(72);
    expect(idleThresholdHours("low", settings)).toBe(168);
    expect(idleThresholdHours("unknown", settings)).toBe(168);
  });
});
