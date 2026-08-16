import { describe, expect, it } from "vitest";
import { ISSUE_RECOVERY_ACTION_KINDS } from "@paperclipai/shared";
import { classifyContinuationFailure } from "../services/recovery/service.ts";
import {
  DISPOSITION_REPAIR_BASE_DELAYS_MS,
  DISPOSITION_REPAIR_MAX_ATTEMPTS,
  dispositionRepairDelayMs,
} from "../services/recovery/disposition-repair.ts";

const deliberateWaitRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "cancelled" as const,
  error: "Continuation parked",
  errorCode: "issue_continuation_waiting_on_review",
  contextSnapshot: {},
  livenessState: null,
  startedAt: new Date("2026-08-11T00:00:00.000Z"),
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
};

describe("owner-sticky disposition repair", () => {
  it("classifies a deliberate wait without a target into its dedicated bounded lane", () => {
    expect(ISSUE_RECOVERY_ACTION_KINDS).toContain("deliberate_wait_without_target");
    expect(classifyContinuationFailure(deliberateWaitRun)).toEqual({
      kind: "deliberate_wait_without_target",
      maxAttempts: 3,
      baseBackoffMs: 60_000,
      errorCode: "issue_continuation_waiting_on_review",
    });
  });

  it("uses immediate, 60-second, and 120-second attempts with bounded deterministic jitter", () => {
    const fingerprint = "disposition_repair:v1:example";
    const timings = [1, 2, 3].map((attempt) => dispositionRepairDelayMs(attempt, fingerprint));

    expect(DISPOSITION_REPAIR_MAX_ATTEMPTS).toBe(3);
    expect(DISPOSITION_REPAIR_BASE_DELAYS_MS).toEqual([0, 60_000, 120_000]);
    expect(timings[0]).toEqual({ baseDelayMs: 0, jitterMs: 0, delayMs: 0 });
    expect(timings[1]?.baseDelayMs).toBe(60_000);
    expect(timings[1]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[1]?.jitterMs).toBeLessThanOrEqual(6_000);
    expect(timings[2]?.baseDelayMs).toBe(120_000);
    expect(timings[2]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[2]?.jitterMs).toBeLessThanOrEqual(12_000);
    expect(dispositionRepairDelayMs(2, fingerprint)).toEqual(timings[1]);
    expect(() => dispositionRepairDelayMs(4, fingerprint)).toThrow(/Invalid disposition repair attempt/);
  });
});
