import { describe, expect, it } from "vitest";
import {
  isHeartbeatExecutionWindowActive,
  parseHeartbeatExecutionWindowPolicy,
} from "../services/heartbeat-policy.ts";

describe("parseHeartbeatExecutionWindowPolicy", () => {
  it("parses and normalizes valid window config", () => {
    const parsed = parseHeartbeatExecutionWindowPolicy({
      executionWindow: {
        startTime: "8:05",
        endTime: "17:30",
      },
    });

    expect(parsed).toEqual({
      startTime: "08:05",
      endTime: "17:30",
      timeZone: "UTC",
    });
  });

  it("returns null when execution window values are invalid", () => {
    expect(parseHeartbeatExecutionWindowPolicy({
      executionWindow: {
        startTime: "25:00",
        endTime: "17:00",
      },
    })).toBeNull();

    expect(parseHeartbeatExecutionWindowPolicy({
      executionWindow: {
        startTime: "09:00",
        endTime: "17:00",
        timeZone: "Mars/Phobos",
      },
    })).toBeNull();
  });
});

describe("isHeartbeatExecutionWindowActive", () => {
  it("evaluates same-day windows using start-inclusive and end-exclusive bounds", () => {
    const policy = {
      startTime: "09:00",
      endTime: "17:00",
      timeZone: "UTC",
    };

    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T08:59:59.000Z"))).toBe(false);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T09:00:00.000Z"))).toBe(true);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T16:59:59.000Z"))).toBe(true);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T17:00:00.000Z"))).toBe(false);
  });

  it("evaluates overnight windows correctly", () => {
    const policy = {
      startTime: "22:00",
      endTime: "05:00",
      timeZone: "UTC",
    };

    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T21:59:59.000Z"))).toBe(false);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T22:00:00.000Z"))).toBe(true);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-21T04:59:59.000Z"))).toBe(true);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-21T05:00:00.000Z"))).toBe(false);
  });

  it("treats matching start and end times as always active", () => {
    const policy = {
      startTime: "00:00",
      endTime: "00:00",
      timeZone: "UTC",
    };

    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T00:00:00.000Z"))).toBe(true);
    expect(isHeartbeatExecutionWindowActive(policy, new Date("2026-03-20T12:34:56.000Z"))).toBe(true);
  });
});
