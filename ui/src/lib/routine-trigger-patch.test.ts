import { describe, expect, it } from "vitest";
import type { RoutineTrigger } from "@paperclipai/shared";
import { buildRoutineTriggerPatch } from "./routine-trigger-patch";

function makeScheduleTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: "Daily",
    enabled: true,
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    nextRunAt: null,
    lastFiredAt: null,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildRoutineTriggerPatch", () => {
  it("preserves an existing schedule trigger timezone when saving edits", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: "UTC" }),
      {
        label: "Daily label edit",
        cronExpression: "0 10 * * *",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: "Daily label edit",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    });
  });

  it("falls back to the local timezone when a schedule trigger has none", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: null }),
      {
        label: "",
        cronExpression: "15 9 * * 1-5",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: null,
      cronExpression: "15 9 * * 1-5",
      timezone: "America/Chicago",
    });
  });
});
