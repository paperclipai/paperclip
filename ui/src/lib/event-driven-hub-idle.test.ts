import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { hasEventDrivenHubIdleDetail, hasEventDrivenHubIdlePath } from "./event-driven-hub-idle";

type HubIdleIssue = Pick<Issue, "status" | "executionPolicy" | "executionState">;

function issue(overrides: Partial<HubIdleIssue>): HubIdleIssue {
  return {
    status: "in_progress",
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

describe("event-driven hub idle helpers", () => {
  it("detects an in-progress issue with an event-driven idle marker", () => {
    expect(hasEventDrivenHubIdlePath(issue({
      executionPolicy: { eventDrivenHubIdle: true } as unknown as Issue["executionPolicy"],
    }))).toBe(true);
    expect(hasEventDrivenHubIdlePath(issue({
      executionState: { idlePath: { kind: "event_driven_hub_idle" } } as unknown as Issue["executionState"],
    }))).toBe(true);
  });

  it("does not mark terminal issues as hub idle", () => {
    expect(hasEventDrivenHubIdlePath(issue({
      status: "done",
      executionPolicy: { eventDrivenHubIdle: true } as unknown as Issue["executionPolicy"],
    }))).toBe(false);
  });

  it("detects hub-idle activity details", () => {
    expect(hasEventDrivenHubIdleDetail({ skipReason: "issue has event-driven hub idle path" })).toBe(true);
    expect(hasEventDrivenHubIdleDetail({ resolutionNote: "folded because the source issue exposes an event-driven hub idle path" })).toBe(true);
    expect(hasEventDrivenHubIdleDetail({ executionPolicy: { waitingPath: { type: "event_driven_park" } } })).toBe(true);
  });
});
