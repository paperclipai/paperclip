import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema, createAgentSchema } from "./agent.js";

describe("agentRuntimeConfigSchema heartbeat.activeHours", () => {
  it("accepts a valid timer window", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        activeHours: {
          start: "09:00",
          end: "18:00",
          timezone: "America/New_York",
        },
        cooldownSec: 10,
      },
    });
    expect(parsed.heartbeat).toMatchObject({
      enabled: true,
      intervalSec: 300,
      cooldownSec: 10,
      activeHours: {
        start: "09:00",
        end: "18:00",
        timezone: "America/New_York",
      },
    });
  });

  it("rejects an invalid timezone", () => {
    const result = agentRuntimeConfigSchema.safeParse({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        activeHours: {
          start: "09:00",
          end: "18:00",
          timezone: "Not/A_Timezone",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: "Invalid timezone identifier" })]),
      );
    }

    const createResult = createAgentSchema.safeParse({
      name: "Windowed",
      adapterType: "process",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          activeHours: {
            start: "09:00",
            end: "18:00",
            timezone: "Not/A_Timezone",
          },
        },
      },
    });
    expect(createResult.success).toBe(false);
  });

  it("rejects a start or end that is not HH:MM", () => {
    const result = agentRuntimeConfigSchema.safeParse({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        activeHours: {
          start: "9:00",
          end: "18:00",
          timezone: "UTC",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting the window", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    });
    expect(parsed.heartbeat).toMatchObject({
      enabled: true,
      intervalSec: 300,
    });
    expect(
      parsed.heartbeat && typeof parsed.heartbeat === "object"
        ? (parsed.heartbeat as { activeHours?: unknown }).activeHours
        : undefined,
    ).toBeUndefined();
  });

  it("allows clearing the window with null", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        activeHours: null,
      },
    });
    expect(parsed.heartbeat).toMatchObject({
      enabled: true,
      intervalSec: 300,
      activeHours: null,
    });
  });
});
