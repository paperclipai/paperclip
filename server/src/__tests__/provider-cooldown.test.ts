import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createProviderCooldownService } from "../services/provider-cooldown.ts";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("ProviderCooldownService — route-level isolation", () => {
  it("setCooldown for flash does not block flash-lite", () => {
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");

    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(true);
    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash-lite")).toBe(false);
  });

  it("setCooldown for one provider does not block a different provider", () => {
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");

    expect(svc.isCoolingDown("claude_local:claude-sonnet-4-6")).toBe(false);
  });

  it("isCoolingDown returns false for unknown route", () => {
    const svc = createProviderCooldownService();
    expect(svc.isCoolingDown("unknown_route")).toBe(false);
  });

  it("clearCooldown removes an active cooldown", () => {
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");
    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(true);
    svc.clearCooldown("gemini_local:gemini-2.5-flash");
    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(false);
  });

  it("longer existing cooldown is not shortened by a shorter new one", () => {
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 120_000, "quota_exceeded");
    const stateBefore = svc.getCooldownState("gemini_local:gemini-2.5-flash");
    svc.setCooldown("gemini_local:gemini-2.5-flash", 10_000, "quota_exceeded");
    const stateAfter = svc.getCooldownState("gemini_local:gemini-2.5-flash");
    expect(stateAfter?.until.getTime()).toBe(stateBefore?.until.getTime());
  });

  it("expired cooldown is cleaned up and returns false", () => {
    vi.useFakeTimers();
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 1_000, "quota_exceeded");

    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(false);
    vi.useRealTimers();
  });

  it("getAllCooldownStates filters expired entries", () => {
    vi.useFakeTimers();
    const svc = createProviderCooldownService();
    svc.setCooldown("route-a", 1_000, "quota_exceeded");
    svc.setCooldown("route-b", 60_000, "quota_exceeded");

    vi.advanceTimersByTime(2_000);
    const active = svc.getAllCooldownStates();
    expect(active.has("route-a")).toBe(false);
    expect(active.has("route-b")).toBe(true);
    vi.useRealTimers();
  });
});

describe("ProviderCooldownService — disk persistence", () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-test-"));
    persistPath = path.join(tmpDir, "cooldown-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists cooldown state to disk on setCooldown", () => {
    const svc = createProviderCooldownService({ persistPath });
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");

    expect(fs.existsSync(persistPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    expect(raw["gemini_local:gemini-2.5-flash"]).toBeDefined();
    expect(raw["gemini_local:gemini-2.5-flash"].reason).toBe("quota_exceeded");
  });

  it("reloads non-expired entries on startup", () => {
    const svc1 = createProviderCooldownService({ persistPath });
    svc1.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");

    // Create a new service instance — simulates server restart
    const svc2 = createProviderCooldownService({ persistPath });
    expect(svc2.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(true);
    expect(svc2.isCoolingDown("gemini_local:gemini-2.5-flash-lite")).toBe(false);
  });

  it("does not reload expired entries on startup", () => {
    // Write a state file with an already-expired entry
    const expired = new Date(Date.now() - 5_000).toISOString();
    fs.writeFileSync(
      persistPath,
      JSON.stringify({ "stale-route": { until: expired, reason: "test" } }),
      "utf8",
    );

    const svc = createProviderCooldownService({ persistPath });
    expect(svc.isCoolingDown("stale-route")).toBe(false);
    expect(svc.getAllCooldownStates().size).toBe(0);
  });

  it("removes entry from disk on clearCooldown", () => {
    const svc = createProviderCooldownService({ persistPath });
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");
    svc.clearCooldown("gemini_local:gemini-2.5-flash");

    const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    expect(raw["gemini_local:gemini-2.5-flash"]).toBeUndefined();
  });

  it("works without persistPath (pure in-memory)", () => {
    const svc = createProviderCooldownService();
    svc.setCooldown("gemini_local:gemini-2.5-flash", 60_000, "quota_exceeded");
    expect(svc.isCoolingDown("gemini_local:gemini-2.5-flash")).toBe(true);
    expect(fs.existsSync(persistPath)).toBe(false);
  });
});
