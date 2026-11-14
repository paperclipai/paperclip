import { describe, expect, it } from "vitest";

describe("automatic-run brake module graph", () => {
  it("loads with the server's heartbeat and recovery modules in the order the server imports them", async () => {
    await expect(import("../services/heartbeat.js")).resolves.toBeDefined();
    const brake = await import("../services/recovery/automatic-run-brake.js");
    const rules = await brake.automaticRunOutcomeRules();
    expect(rules.isTransientSetupCode("environment_provider_unavailable")).toBe(true);
    expect(rules.isPersonOwnedFailureCode("budget_hard_stop")).toBe(true);
  }, 600_000);
});
