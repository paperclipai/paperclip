import { describe, expect, it } from "vitest";
import { shouldRejectWakeupForAgentStatus } from "../services/heartbeat.ts";

describe("heartbeat wakeup status guard", () => {
  it("allows paused agents to queue wakeups while still rejecting terminal states", () => {
    expect(shouldRejectWakeupForAgentStatus("paused")).toBe(false);
    expect(shouldRejectWakeupForAgentStatus("terminated")).toBe(true);
    expect(shouldRejectWakeupForAgentStatus("pending_approval")).toBe(true);
  });
});
