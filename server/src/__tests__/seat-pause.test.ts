import { describe, expect, it } from "vitest";
import {
  addSeatPauseReason,
  applySeatPauseInfo,
  getSeatPauseInfo,
  removeSeatPauseReason,
} from "../services/seat-pause.js";

describe("seat pause helpers", () => {
  it("defaults a paused seat with no metadata to manual admin", () => {
    expect(getSeatPauseInfo({ status: "paused", metadata: null })).toEqual({
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin"],
    });
  });

  it("adds budget enforcement as a secondary reason on a manually paused seat", () => {
    const metadata = addSeatPauseReason({
      metadata: null,
      currentStatus: "paused",
      reason: "budget_enforcement",
      now: new Date("2026-03-31T00:00:00.000Z"),
    });

    expect(getSeatPauseInfo({ status: "paused", metadata })).toEqual({
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin", "budget_enforcement"],
    });
    expect((metadata.budgetPause as Record<string, unknown>).source).toBe("budget");
  });

  it("removes budget enforcement without clearing a non-budget pause", () => {
    const metadata = applySeatPauseInfo({
      metadata: null,
      status: "paused",
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin", "budget_enforcement"],
    });

    const next = removeSeatPauseReason({
      metadata,
      currentStatus: "paused",
      reason: "budget_enforcement",
    });

    expect(next.pauseReason).toBe("manual_admin");
    expect(next.pauseReasons).toEqual(["manual_admin"]);
    expect(getSeatPauseInfo({ status: "paused", metadata: next.metadata })).toEqual({
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin"],
    });
  });

  it("writes and clears explicit maintenance metadata", () => {
    const pausedMetadata = applySeatPauseInfo({
      metadata: { delegatedPermissions: ["tasks:assign"] },
      status: "paused",
      pauseReason: "maintenance",
      pauseReasons: ["maintenance"],
      pausedAt: "2026-03-31T00:00:00.000Z",
    });
    expect(getSeatPauseInfo({ status: "paused", metadata: pausedMetadata })).toEqual({
      pauseReason: "maintenance",
      pauseReasons: ["maintenance"],
    });

    const activeMetadata = applySeatPauseInfo({
      metadata: pausedMetadata,
      status: "active",
      pauseReason: null,
      pauseReasons: [],
    });
    expect(activeMetadata).toEqual({
      delegatedPermissions: ["tasks:assign"],
    });
  });
});
