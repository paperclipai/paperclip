import { describe, expect, it } from "vitest";
import { createTransportFailureTracker } from "../services/tool-connection-transport-failures.js";

describe("createTransportFailureTracker", () => {
  it("does not flag an isolated failure", () => {
    const tracker = createTransportFailureTracker();
    expect(tracker.recordFailure("a")).toBe(false);
  });

  it("flags the connection after the threshold of consecutive failures", () => {
    const tracker = createTransportFailureTracker({ threshold: 3 });
    expect(tracker.recordFailure("a")).toBe(false);
    expect(tracker.recordFailure("a")).toBe(false);
    expect(tracker.recordFailure("a")).toBe(true);
    expect(tracker.recordFailure("a")).toBe(true);
  });

  it("resets the count after a success", () => {
    const tracker = createTransportFailureTracker({ threshold: 2 });
    tracker.recordFailure("a");
    tracker.recordSuccess("a");
    expect(tracker.recordFailure("a")).toBe(false);
  });

  it("starts a new count when failures are further apart than the window", () => {
    let time = 0;
    const tracker = createTransportFailureTracker({ threshold: 2, windowMs: 1000, now: () => time });
    tracker.recordFailure("a");
    time = 5000;
    expect(tracker.recordFailure("a")).toBe(false);
  });

  it("counts each connection on its own", () => {
    const tracker = createTransportFailureTracker({ threshold: 2 });
    tracker.recordFailure("a");
    expect(tracker.recordFailure("b")).toBe(false);
  });
});
