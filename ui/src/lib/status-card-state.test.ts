import { describe, expect, it } from "vitest";
import type { StatusCard, StatusCardRefreshPolicy } from "@paperclipai/shared";
import {
  deriveStatusCardLifecycle,
  describeRefreshPolicy,
  STATUS_CARD_LIFECYCLE_PRESENTATION,
} from "./status-card-state";

type LifecycleInput = Pick<StatusCard, "state" | "archivedAt" | "generatingIssueId" | "pendingChangeCount">;

function card(overrides: Partial<LifecycleInput>): LifecycleInput {
  return {
    state: "active",
    archivedAt: null,
    generatingIssueId: null,
    pendingChangeCount: 0,
    ...overrides,
  };
}

describe("deriveStatusCardLifecycle", () => {
  it("maps compiling", () => {
    expect(deriveStatusCardLifecycle(card({ state: "compiling" }))).toBe("compiling");
  });

  it("maps a clean active card to fresh", () => {
    expect(deriveStatusCardLifecycle(card({ state: "active", pendingChangeCount: 0 }))).toBe("fresh");
  });

  it("maps an active card with pending changes to stale", () => {
    expect(deriveStatusCardLifecycle(card({ state: "active", pendingChangeCount: 5 }))).toBe("stale");
  });

  it("maps an in-flight generation to updating", () => {
    expect(deriveStatusCardLifecycle(card({ generatingIssueId: "issue-1", pendingChangeCount: 3 }))).toBe("updating");
  });

  it("maps error and paused states", () => {
    expect(deriveStatusCardLifecycle(card({ state: "error" }))).toBe("error");
    expect(deriveStatusCardLifecycle(card({ state: "paused_budget" }))).toBe("paused_budget");
    expect(deriveStatusCardLifecycle(card({ state: "paused_hours" }))).toBe("paused_hours");
  });

  it("archived wins over every other state", () => {
    expect(
      deriveStatusCardLifecycle(
        card({ state: "error", archivedAt: "2026-07-22T00:00:00.000Z", generatingIssueId: "x", pendingChangeCount: 9 }),
      ),
    ).toBe("archived");
  });

  it("has a presentation entry for every lifecycle", () => {
    for (const lifecycle of Object.keys(STATUS_CARD_LIFECYCLE_PRESENTATION)) {
      expect(STATUS_CARD_LIFECYCLE_PRESENTATION[lifecycle as keyof typeof STATUS_CARD_LIFECYCLE_PRESENTATION].label).toBeTruthy();
    }
  });
});

describe("describeRefreshPolicy", () => {
  const base: StatusCardRefreshPolicy = {
    mode: "manual",
    triggers: {
      statusTransitions: true,
      membershipChanges: true,
      humanComments: true,
      assigneeChanges: true,
      anyUpdate: false,
    },
  };

  it("describes manual", () => {
    expect(describeRefreshPolicy(base)).toBe("manual");
  });

  it("describes an interval policy", () => {
    expect(describeRefreshPolicy({ ...base, mode: "interval", intervalMinutes: 15 })).toBe("every 15m if changed");
  });

  it("describes a reactive policy", () => {
    expect(describeRefreshPolicy({ ...base, mode: "reactive", debounceSeconds: 60 })).toBe("on change (60s)");
  });
});
