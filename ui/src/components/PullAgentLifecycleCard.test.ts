import { describe, expect, it } from "vitest";
import { formatPullLifecycleObserved } from "./PullAgentLifecycleCard";

describe("formatPullLifecycleObserved", () => {
  it("renders never when no lease has been observed", () => {
    expect(formatPullLifecycleObserved(null)).toBe("never");
    expect(formatPullLifecycleObserved(undefined)).toBe("never");
    expect(formatPullLifecycleObserved("not-a-date")).toBe("never");
  });

  it("renders relative time for a valid observation", () => {
    const observed = formatPullLifecycleObserved("2026-08-14T20:00:00.000Z");
    expect(observed).not.toBe("never");
    expect(observed.length).toBeGreaterThan(0);
  });
});
