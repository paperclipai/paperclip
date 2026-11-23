import { describe, expect, it } from "vitest";
import {
  ROUTINE_EXTERNAL_SOURCES,
  externalRoutineOriginKind,
  isExternalRoutineOriginKind,
  parseExternalRoutineOriginKind,
  upsertExternalRoutinesSchema,
  createRoutineObservationSchema,
} from "@paperclipai/shared";

describe("external routine origin kinds", () => {
  it("builds and recognizes external:<source> origin kinds", () => {
    expect(externalRoutineOriginKind("systemd")).toBe("external:systemd");
    expect(isExternalRoutineOriginKind("external:hermes")).toBe(true);
    expect(isExternalRoutineOriginKind("manual")).toBe(false);
    expect(isExternalRoutineOriginKind(null)).toBe(false);
    expect(isExternalRoutineOriginKind(undefined)).toBe(false);
  });

  it("round-trips every declared external source", () => {
    for (const source of ROUTINE_EXTERNAL_SOURCES) {
      expect(parseExternalRoutineOriginKind(externalRoutineOriginKind(source))).toBe(source);
    }
  });

  it("returns null for unknown sources so foreign origin kinds stay external-safe but unlabeled", () => {
    expect(parseExternalRoutineOriginKind("external:not-a-source")).toBeNull();
    // Unknown external-<source> kinds must still read as external so no
    // dispatch path can be tricked into firing them.
    expect(isExternalRoutineOriginKind("external:not-a-source")).toBe(true);
  });
});

describe("external routine payload validation", () => {
  it("accepts a minimal manifest upsert item", () => {
    const parsed = upsertExternalRoutinesSchema.parse({
      items: [{ id: "gbos.systemd.backup", source: "systemd", title: "Nightly backup" }],
    });
    expect(parsed.items[0].status).toBe("active");
  });

  it("rejects non-declared sources and empty ids", () => {
    expect(() =>
      upsertExternalRoutinesSchema.parse({
        items: [{ id: "x", source: "quartz", title: "Nope" }],
      }),
    ).toThrow();

    expect(() =>
      upsertExternalRoutinesSchema.parse({
        items: [{ id: "", source: "hermes", title: "Nope" }],
      }),
    ).toThrow();
  });

  it("rejects oversized upsert batches", () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      id: `ext-${index}`,
      source: "systemd",
      title: `Systemd scheduler ${index}`,
    }));
    expect(() => upsertExternalRoutinesSchema.parse({ items })).toThrow();
  });

  it("maps observation statuses and keeps failure metadata", () => {
    const parsed = createRoutineObservationSchema.parse({
      status: "failure",
      durationMs: 1500,
      host: "greybeard-one",
      unit: "gb-backup.service",
      costUsd: 0.02,
      failureReason: "exit code 1",
      idempotencyKey: "gbos-run-42",
    });
    expect(parsed.status).toBe("failure");
    expect(parsed.failureReason).toBe("exit code 1");
    expect(parsed.idempotencyKey).toBe("gbos-run-42");
  });

  it("rejects unknown observation statuses", () => {
    expect(() => createRoutineObservationSchema.parse({ status: "halfway" })).toThrow();
  });
});
