import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomProcessTriggerService } from "../features/custom-process/custom-process-trigger.service.js";

describe("custom process trigger service", () => {
  const service = new CustomProcessTriggerService();
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("does nothing when config is missing or disabled", async () => {
    await expect(service.trigger({ event: "manual" })).resolves.toMatchObject({
      triggered: false,
      reason: "missing_config",
    });
    await expect(service.trigger({
      event: "manual",
      organizationConfig: { customProcess: { enabled: false } },
    })).resolves.toMatchObject({
      triggered: false,
      reason: "disabled",
    });
  });

  it("returns configured generic instructions only when enabled", async () => {
    await expect(service.trigger({
      event: "manual",
      organizationConfig: {
        customProcess: {
          enabled: true,
          instructions: "Create a local handoff.",
          triggers: [{ event: "manual", enabled: true }],
        },
      },
    })).resolves.toMatchObject({
      triggered: true,
      reason: "triggered",
      instructions: "Create a local handoff.",
    });
  });

  it("does nothing outside development mode", async () => {
    process.env.NODE_ENV = "production";

    await expect(service.trigger({
      event: "manual",
      organizationConfig: {
        customProcess: {
          enabled: true,
          instructions: "Create a local handoff.",
          triggers: [{ event: "manual", enabled: true }],
        },
      },
    })).resolves.toMatchObject({
      triggered: false,
      reason: "disabled",
    });
  });
});
