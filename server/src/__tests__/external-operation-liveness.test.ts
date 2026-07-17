import { describe, expect, it } from "vitest";
import {
  isBoundedExternalOperationProgressPath,
  readExternalOperationControllerAttemptMinutes,
} from "../services/external-operation-liveness.js";

describe("external operation liveness ownership", () => {
  const now = new Date("2026-07-17T10:00:00.000Z");
  const bounded = {
    state: "running",
    terminalAt: null,
    nextCheckAt: new Date("2026-07-17T10:05:00.000Z"),
    timeoutAt: new Date("2026-07-17T11:00:00.000Z"),
    metadata: { paperclipController: { attemptCount: 2, maxAttempts: 10 } },
  };

  it("recognizes a bounded controller-owned wait", () => {
    expect(isBoundedExternalOperationProgressPath(bounded, now)).toBe(true);
  });

  it.each([
    ["missing timeout", { timeoutAt: null }],
    ["expired timeout", { timeoutAt: new Date("2026-07-17T10:00:00.000Z") }],
    ["missing next check", { nextCheckAt: null }],
    ["next check after timeout", {
      nextCheckAt: new Date("2026-07-17T11:00:00.001Z"),
    }],
    ["exhausted attempts", {
      metadata: { paperclipController: { attemptCount: 10, maxAttempts: 10 } },
    }],
    ["terminal state", { state: "succeeded" }],
    ["terminal timestamp", { terminalAt: new Date("2026-07-17T09:59:00.000Z") }],
  ])("rejects %s as progress ownership", (_label, patch) => {
    expect(isBoundedExternalOperationProgressPath({ ...bounded, ...patch }, now)).toBe(false);
  });

  it("accepts only a short, increasing, bounded retry schedule", () => {
    expect(readExternalOperationControllerAttemptMinutes({
      paperclipController: { attemptMinutes: [2, 10, 30] },
    })).toEqual([2, 10, 30]);
    for (const attemptMinutes of [
      [],
      [0, 2],
      [2, 2],
      [10, 2],
      [2, 10, 30, 60],
      [2, 61],
      [2, 2.5],
    ]) {
      expect(readExternalOperationControllerAttemptMinutes({
        paperclipController: { attemptMinutes },
      })).toBeNull();
    }
  });
});
