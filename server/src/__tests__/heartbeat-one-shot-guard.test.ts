import { describe, expect, it } from "vitest";
import { shouldSuppressWakeupForOneShotMode } from "../services/heartbeat.ts";

describe("shouldSuppressWakeupForOneShotMode", () => {
  it("suppresses automatic wakes for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "system",
      source: "automation",
    })).toBe(true);
  });

  it("suppresses timer-source wakes for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "system",
      source: "timer",
    })).toBe(true);
  });

  it("suppresses assignment-source wakes for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "system",
      source: "assignment",
    })).toBe(true);
  });

  it("allows user-requested on_demand wakes for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "user",
      source: "on_demand",
    })).toBe(false);
  });

  it("allows user-requested wakes regardless of source for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "user",
      source: "automation",
    })).toBe(false);
  });

  it("allows on_demand wakes from non-user actors for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "system",
      source: "on_demand",
    })).toBe(false);
  });

  it("does not suppress wakes for non-one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "continuous" },
      requestedByActorType: "system",
      source: "automation",
    })).toBe(false);
  });

  it("does not suppress wakes when executionMode is absent", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: {},
      requestedByActorType: "system",
      source: "automation",
    })).toBe(false);
  });

  it("does not suppress wakes when runtimeConfig is null", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: null,
      requestedByActorType: "system",
      source: "automation",
    })).toBe(false);
  });

  it("does not suppress wakes when runtimeConfig is a non-object", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: "one_shot",
      requestedByActorType: "system",
      source: "automation",
    })).toBe(false);
  });

  it("suppresses agent-requested automatic wakes for one_shot agents", () => {
    expect(shouldSuppressWakeupForOneShotMode({
      runtimeConfig: { executionMode: "one_shot" },
      requestedByActorType: "agent",
      source: "automation",
    })).toBe(true);
  });
});
