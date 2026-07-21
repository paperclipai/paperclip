import { describe, expect, it } from "vitest";
import { createRoutineExceptionFingerprint } from "../services/routines.ts";

describe("routine exception fingerprints", () => {
  it("removes volatile timestamps and run ids from otherwise identical root causes", () => {
    const common = {
      routineId: "11111111-1111-4111-8111-111111111111",
      contractVersion: "runtime-sot-v1",
      affectedResource: "paper-runtime",
    };
    const first = createRoutineExceptionFingerprint({
      ...common,
      normalizedRootCause:
        "Heartbeat stale at 2026-07-21T12:34:56Z for run 22222222-2222-4222-8222-222222222222",
    });
    const retry = createRoutineExceptionFingerprint({
      ...common,
      normalizedRootCause:
        "heartbeat stale at 2026-07-21T12:35:56Z for run 33333333-3333-4333-8333-333333333333",
    });

    expect(retry).toBe(first);
  });

  it("keeps distinct critical root causes separate", () => {
    const common = {
      routineId: "11111111-1111-4111-8111-111111111111",
      contractVersion: "runtime-sot-v1",
      affectedResource: "paper-runtime",
    };

    expect(createRoutineExceptionFingerprint({ ...common, normalizedRootCause: "heartbeat stale" }))
      .not.toBe(createRoutineExceptionFingerprint({ ...common, normalizedRootCause: "boot commit mismatch" }));
  });
});
