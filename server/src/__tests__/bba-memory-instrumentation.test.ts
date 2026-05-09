import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock factories so they are available before module imports are resolved.
const mocks = vi.hoisted(() => ({
  startRun: vi.fn().mockReturnValue(42),
  completeRun: vi.fn(),
  recordFailure: vi.fn(),
  classifyFailure: vi.fn().mockResolvedValue("NAVIGATION_TIMEOUT"),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../services/bba-memory/index.js", () => ({
  startRun: mocks.startRun,
  completeRun: mocks.completeRun,
  recordFailure: mocks.recordFailure,
}));

vi.mock("../services/bba-detector.js", () => ({
  classifyFailure: mocks.classifyFailure,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));

import { instrumentBettingService } from "../services/bba-memory-instrumentation.js";

const RUN_ID = 42;
const BASE_REQ = { companyId: "C1", issueId: "I1", bet: { matchLabel: "Team A vs Team B" } };

function buildFakeSvc(executeImpl: (req: any) => Promise<any>) {
  return { execute: executeImpl, otherMethod: () => "passthrough" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startRun.mockReturnValue(RUN_ID);
  mocks.classifyFailure.mockResolvedValue("NAVIGATION_TIMEOUT");
});

describe("instrumentBettingService", () => {
  it("1 — completed → outcome=success, recordFailure not called, no UNKNOWN failureClass", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "completed", placedBetId: "B1", sessionId: "S1" })),
    );
    const result = await svc.execute(BASE_REQ);

    expect(result.status).toBe("completed");
    expect(mocks.startRun).toHaveBeenCalledOnce();
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalledOnce();
    expect(mocks.completeRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ outcome: "success" }));
    // REGRESSION (#9 duplicate anchor): completed run must not write failureClass=UNKNOWN
    const args = mocks.completeRun.mock.calls[0][1];
    expect(args.failureClass).not.toBe("UNKNOWN");
    expect(args.failureClass).toBeUndefined(); // null (from table) flows through as undefined
  });

  it("2 — submitted_unconfirmed → outcome=partial, failureClass undefined in completeRun", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "submitted_unconfirmed" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ outcome: "partial" }));
    const args = mocks.completeRun.mock.calls[0][1];
    expect(args.failureClass).toBeUndefined();
    expect(mocks.recordFailure).toHaveBeenCalledOnce(); // partial triggers recordFailure
  });

  it("3 — awaiting_confirmation → outcome=partial, failureClass undefined in completeRun", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "awaiting_confirmation" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ outcome: "partial" }));
    const args = mocks.completeRun.mock.calls[0][1];
    expect(args.failureClass).toBeUndefined();
  });

  it("4 — failed → outcome=failure, failureClass=UNKNOWN, recordFailure called with runId", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "failed", failureReason: "Login error" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ outcome: "failure", failureClass: "UNKNOWN" }),
    );
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, failureClass: "UNKNOWN" }),
    );
  });

  it("5 — blocked_by_risk → outcome=failure, failureClass=UNKNOWN", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "blocked_by_risk" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ outcome: "failure", failureClass: "UNKNOWN" }),
    );
    expect(mocks.recordFailure).toHaveBeenCalledOnce();
  });

  it("6 — session_expired → outcome=failure, failureClass=SESSION_NOT_DETECTED, sessionStatusAfter=expired", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "session_expired" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        outcome: "failure",
        failureClass: "SESSION_NOT_DETECTED",
        sessionStatusAfter: "expired",
      }),
    );
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: "SESSION_NOT_DETECTED" }),
    );
  });

  it("7 — unknown status → outcome=failure (fallback), failureClass=UNKNOWN", async () => {
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "weird-status" })),
    );
    await svc.execute(BASE_REQ);

    expect(mocks.completeRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ outcome: "failure", failureClass: "UNKNOWN" }),
    );
    expect(mocks.recordFailure).toHaveBeenCalledOnce();
  });

  it("8 — exception → classifyFailure called, recordFailure called, completeRun failure, error re-thrown", async () => {
    const err = new Error("nav timeout");
    const svc = instrumentBettingService(buildFakeSvc(async () => { throw err; }));

    await expect(svc.execute(BASE_REQ)).rejects.toThrow("nav timeout");

    expect(mocks.classifyFailure).toHaveBeenCalledWith({ errorMessage: "nav timeout" });
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        failureClass: "NAVIGATION_TIMEOUT",
        errorMessage: "nav timeout",
      }),
    );
    expect(mocks.completeRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ outcome: "failure", failureClass: "NAVIGATION_TIMEOUT" }),
    );
  });

  it("9 — REGRESSION: completed must never write failureClass=UNKNOWN (null-coalescing fix)", async () => {
    // Before the Phase B fix, `STATUS_TO_FAILURE_CLASS["completed"] ?? "UNKNOWN"` evaluated
    // to "UNKNOWN" because null is nullish. The `in`-check fix preserves null, which then
    // flows to undefined via `null ?? undefined`. This test pins that contract.
    const svc = instrumentBettingService(
      buildFakeSvc(async () => ({ status: "completed", placedBetId: "BX" })),
    );
    await svc.execute({ companyId: "C2", bet: null });

    expect(mocks.recordFailure).not.toHaveBeenCalled();
    const args = mocks.completeRun.mock.calls[0][1];
    expect(args.failureClass).not.toBe("UNKNOWN");
    // null (from table) becomes undefined via `null ?? undefined`
    expect(args.failureClass == null).toBe(true);
  });
});
