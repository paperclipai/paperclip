import { describe, expect, it } from "vitest";
import { evaluateAutoRetryEligibility } from "../services/auto-retry-scheduler.js";

describe("issue revival wiring", () => {
  it("classifies a fresh process_lost run as retry-eligible", () => {
    const r = evaluateAutoRetryEligibility({
      autoRetryCount: 0,
      error: "Process lost -- server may have restarted",
      errorCode: "process_lost",
      stdoutExcerpt: null,
      status: "failed",
    } as any);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("process_lost");
  });
});
