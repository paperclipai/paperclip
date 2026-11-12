import { describe, expect, it } from "vitest";
import { registeredServiceExclusions } from "./run-descendant-reaper.js";

describe("registeredServiceExclusions", () => {
  const recordedAt = "2026-01-01T00:00:10.000Z";
  const recordedAtMs = Date.parse(recordedAt);

  it("excludes a service PID and group that started before the record", () => {
    const starts = new Map([[100, recordedAtMs - 60_000]]);
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], (pid) => starts.get(pid) ?? null),
    ).toEqual({ pids: [100], processGroupIds: [100] });
  });

  it("does not exclude a PID or group leader reused after the record was written", () => {
    const starts = new Map([[100, recordedAtMs + 60_000]]);
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], (pid) => starts.get(pid) ?? null),
    ).toEqual({ pids: [], processGroupIds: [] });
  });

  it("keeps a group whose leader is gone, and drops a gone PID", () => {
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], () => null),
    ).toEqual({ pids: [], processGroupIds: [100] });
  });

  it("does not exclude anything for a record with an unreadable start time", () => {
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: null, startedAt: "not a date" }], () => recordedAtMs),
    ).toEqual({ pids: [], processGroupIds: [] });
  });
});
