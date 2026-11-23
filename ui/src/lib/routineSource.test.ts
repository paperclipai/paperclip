import { describe, expect, it } from "vitest";
import { ROUTINE_EXTERNAL_SOURCES } from "@paperclipai/shared";
import {
  ROUTINE_SOURCE_LABELS,
  isExternalRoutineItem,
  routineHealth,
  routineHealthLabel,
  routineSourceLabel,
  routineSourceOf,
} from "./routineSource";

describe("routineSource", () => {
  it("maps external origin kinds to labels", () => {
    expect(routineSourceLabel({ originKind: "external:systemd" })).toBe("systemd");
    expect(routineSourceLabel({ originKind: "external:grokbot" })).toBe("Grok Bot");
    expect(routineSourceLabel({ originKind: "manual" })).toBe("Paperclip");
    expect(routineSourceLabel({})).toBe("Paperclip");
  });

  it("derives the filter source identity from the origin kind", () => {
    expect(routineSourceOf({ originKind: "external:k8s" })).toBe("k8s");
    expect(routineSourceOf({ originKind: "unknown-kind" })).toBe("paperclip");
  });

  it("flags external rows read-only at the item level", () => {
    expect(isExternalRoutineItem({ originKind: "external:hermes" })).toBe(true);
    expect(isExternalRoutineItem({ originKind: "manual" })).toBe(false);
    expect(isExternalRoutineItem({})).toBe(false);
  });

  it("keeps every declared shared source covered by the label map", () => {
    for (const source of ROUTINE_EXTERNAL_SOURCES) {
      expect(ROUTINE_SOURCE_LABELS[source]).toBeTruthy();
    }
  });
});

describe("routineHealth", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");

  it("returns failing only for failed runs", () => {
    expect(routineHealth(
      { lastRun: { status: "failed", triggeredAt: new Date(now - 60_000).toISOString() } },
      now,
    )).toBe("failing");
  });

  it("returns stale when the last run is older than twice the cadence", () => {
    expect(routineHealth(
      {
        lastRun: {
          status: "completed",
          triggeredAt: new Date(now - 3 * 300 * 1000).toISOString(),
          triggerPayload: { cadenceSec: 300 },
        },
      },
      now,
    )).toBe("stale");
  });

  it("returns healthy inside the staleness window", () => {
    expect(routineHealth(
      {
        lastRun: {
          status: "completed",
          triggeredAt: new Date(now - 60_000).toISOString(),
          triggerPayload: { cadenceSec: 300 },
        },
      },
      now,
    )).toBe("healthy");
  });

  it("returns unknown without cadence or runs", () => {
    expect(routineHealth({}, now)).toBe("unknown");
    expect(routineHealth(
      { lastRun: { status: "completed", triggeredAt: new Date(now - 36 * 3600 * 1000).toISOString() } },
      now,
    )).toBe("healthy");
  });

  it("humanizes labels", () => {
    expect(routineHealthLabel("stale")).toBe("Stale");
    expect(routineHealthLabel("unknown")).toBe("No runs yet");
  });
});
