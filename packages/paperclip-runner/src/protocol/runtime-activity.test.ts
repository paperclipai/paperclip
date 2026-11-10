import { describe, expect, it } from "vitest";
import { validatePrpEvent, type PrpEvent } from "./replay-contract.js";

function event(version: 1 | 2 | 3, activityKey: string): PrpEvent {
  return {
    schema: `paperclip.prp.event.v${version}`, schemaVersion: version,
    sourceEventId: "activity-1", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner",
    runId: "run", normalizedSessionId: "session", eventType: "runtime.activity.recorded", priority: 1,
    emittedAt: "2099-01-01T00:00:00.000Z", payload: { namespace: "example.runtime", activityKey },
  };
}

describe.each([1, 2, 3] as const)("PRP v%s runtime activity identifiers", version => {
  it("counts Unicode code points and excludes only ASCII controls", () => {
    for (const value of ["视".repeat(60), "😀".repeat(160), "view-0", "\u0085"]) {
      expect(validatePrpEvent(event(version, value)).ok).toBe(true);
    }
    for (const value of ["😀".repeat(161), "", "\u001f", "\u007f"]) {
      expect(validatePrpEvent(event(version, value)).ok).toBe(false);
    }
  });
  it("keeps activity payload independent of UI and caller-supplied attribution", () => {
    for (const payload of [
      { pluginKey: "example.plugin", slotId: "panel" },
      { namespace: "example.runtime", activityKey: "desktop.used", runId: "other-run" },
      { namespace: "example.runtime", activityKey: "desktop.used", agentId: "other-agent" },
      { namespace: "example.runtime", activityKey: "desktop.used", issueId: "other-task" },
    ]) expect(validatePrpEvent({ ...event(version, "desktop.used"), payload }).ok).toBe(false);
  });
});
