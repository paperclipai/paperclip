import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("classifyContinuationFailure sandbox capacity codes", () => {
  it("classifies sandbox_unschedulable as transient_infra with a 5 minute base backoff", () => {
    const c = classifyContinuationFailure(run("sandbox_unschedulable"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBe(3);
    expect(c.baseBackoffMs).toBe(5 * 60_000);
  });

  it("classifies sandbox_not_ready as transient_infra with a 5 minute base backoff", () => {
    const c = classifyContinuationFailure(run("sandbox_not_ready"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBe(3);
    expect(c.baseBackoffMs).toBe(5 * 60_000);
  });

  it("keeps the generic adapter_failed backoff unchanged (60s)", () => {
    const c = classifyContinuationFailure(run("adapter_failed"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBe(3);
    expect(c.baseBackoffMs).toBe(60_000);
  });
});
