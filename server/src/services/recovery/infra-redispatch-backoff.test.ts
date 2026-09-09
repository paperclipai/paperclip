import { describe, expect, it } from "vitest";
import {
  INFRA_REDISPATCH_BACKOFF_NOTICE_TITLE,
  buildInfraRedispatchBackoffNotice,
  evaluateInfraRedispatchBackoff,
  formatInfraBackoffDuration,
  infraRedispatchBackoffMs,
} from "./infra-redispatch-backoff.js";

// The defaults are read from the environment at import time, so every case here
// passes an explicit policy: these assertions are about the shape of the ladder,
// not about whichever thresholds this host happens to be running.
const POLICY = { threshold: 2, baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000 };
const KILLED_AT = new Date("2026-03-19T00:05:00.000Z");

function at(offsetMs: number) {
  return new Date(KILLED_AT.getTime() + offsetMs);
}

describe("infraRedispatchBackoffMs", () => {
  it("holds at the base cooldown for the first deferred dispatch", () => {
    expect(infraRedispatchBackoffMs(2, POLICY)).toBe(30 * 60_000);
  });

  it("doubles for each additional consecutive infra kill", () => {
    expect(infraRedispatchBackoffMs(3, POLICY)).toBe(60 * 60_000);
    expect(infraRedispatchBackoffMs(4, POLICY)).toBe(2 * 60 * 60_000);
  });

  it("caps the doubling so an issue is never held longer than the maximum", () => {
    expect(infraRedispatchBackoffMs(50, POLICY)).toBe(POLICY.maxMs);
  });
});

describe("evaluateInfraRedispatchBackoff", () => {
  it("dispatches below the threshold so a single infra kill costs no delay", () => {
    expect(
      evaluateInfraRedispatchBackoff({
        consecutive: 1,
        latestFinishedAt: KILLED_AT,
        now: at(1_000),
        policy: POLICY,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("defers once the threshold is reached and the cooldown has not elapsed", () => {
    const decision = evaluateInfraRedispatchBackoff({
      consecutive: 2,
      latestFinishedAt: KILLED_AT,
      now: at(60_000),
      policy: POLICY,
    });

    expect(decision).toEqual({
      kind: "defer",
      consecutive: 2,
      cooldownMs: 30 * 60_000,
      retryAt: at(30 * 60_000),
    });
  });

  // The acceptance criterion that matters most: recovery has to resume on its
  // own. Nothing in this path requires an operator to unpark the issue.
  it("dispatches again once the cooldown has elapsed, with no manual unpark", () => {
    expect(
      evaluateInfraRedispatchBackoff({
        consecutive: 2,
        latestFinishedAt: KILLED_AT,
        now: at(30 * 60_000),
        policy: POLICY,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("fails open when the killed run never recorded a finish time", () => {
    expect(
      evaluateInfraRedispatchBackoff({
        consecutive: 9,
        latestFinishedAt: null,
        now: at(0),
        policy: POLICY,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("measures the cooldown from the kill, so a longer outage waits longer", () => {
    const decision = evaluateInfraRedispatchBackoff({
      consecutive: 4,
      latestFinishedAt: KILLED_AT,
      now: at(90 * 60_000),
      policy: POLICY,
    });

    expect(decision).toMatchObject({ kind: "defer", cooldownMs: 2 * 60 * 60_000 });
  });
});

describe("formatInfraBackoffDuration", () => {
  it("renders minutes, whole hours, and mixed durations", () => {
    expect(formatInfraBackoffDuration(30 * 60_000)).toBe("30m");
    expect(formatInfraBackoffDuration(2 * 60 * 60_000)).toBe("2h");
    expect(formatInfraBackoffDuration(90 * 60_000)).toBe("1h 30m");
  });
});

describe("buildInfraRedispatchBackoffNotice", () => {
  const notice = buildInfraRedispatchBackoffNotice({
    consecutive: 3,
    cooldownMs: 60 * 60_000,
    retryAt: at(60 * 60_000),
    latestRun: { id: "run-1", status: "failed", agentId: "agent-1", errorCode: "process_lost" },
  });

  // "The issue surfaces a legible reason rather than looking like a stuck or
  // failing agent" — so the notice has to name the platform as the cause and
  // say plainly that nobody needs to do anything.
  it("blames the platform rather than the assigned agent", () => {
    expect(notice.body).toContain("terminated by the platform");
    expect(notice.body).toContain("not by the assigned agent");
    expect(notice.presentation).toMatchObject({
      tone: "warning",
      title: INFRA_REDISPATCH_BACKOFF_NOTICE_TITLE,
    });
  });

  it("states that recovery is automatic and needs no manual action", () => {
    expect(notice.body).toContain("needs no manual action");
    expect(notice.body).toContain("recovery resumes automatically");
  });

  it("records the run it backed off from so the notice can be deduped", () => {
    expect(notice.metadata.sourceRunId).toBe("run-1");
  });

  it("surfaces the cooldown, the count, and the next attempt as metadata", () => {
    const rows = notice.metadata.sections?.[0]?.rows ?? [];
    const rendered = JSON.stringify(rows);
    expect(rendered).toContain("1h");
    expect(rendered).toContain("Consecutive infra-caused terminations");
    expect(rendered).toContain(at(60 * 60_000).toISOString());
    expect(rendered).toContain("process_lost");
  });
});
