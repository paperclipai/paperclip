import { describe, expect, it } from "vitest";
import { shouldRouteRecoveryToOriginalAgent } from "./service.js";

describe("native runner recovery routing", () => {
  it.each([
    "native_session_interrupted",
    "native_runner_process_exited",
    "provider_transport_failed",
    "provider_frame_too_large",
  ] as const)("keeps %s with the original runner", (cause) => {
    expect(shouldRouteRecoveryToOriginalAgent(cause)).toBe(true);
  });

  it("does not change ordinary stranded-issue manager routing", () => {
    expect(shouldRouteRecoveryToOriginalAgent("stranded_assigned_issue")).toBe(false);
  });
});
