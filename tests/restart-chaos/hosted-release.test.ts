import { describe, expect, it } from "vitest";
import { continuity, detectReleases, releaseMarkdown, type HealthSample } from "./hosted-release.js";

const A = { processStartedAt: "2026-11-12T16:00:00.000Z", commit: "aaaaaaaaaa" };
const B = { processStartedAt: "2026-11-12T16:40:00.000Z", commit: "bbbbbbbbbb" };
const C = { processStartedAt: "2026-11-12T17:20:00.000Z", commit: "bbbbbbbbbb" };
const ok = (at: number, build: typeof A, ms = 100): HealthSample => ({ at, ok: true, status: 200, ms, ...build });
const fail = (at: number, status: number | null = 502): HealthSample => ({ at, ok: false, status, ms: 50, processStartedAt: null, commit: null });

describe("hosted release detection", () => {
  it("sees an overlap swap: two builds answer for a while, no request fails", () => {
    const samples = [ok(0, A), ok(2_000, A), ok(4_000, B), ok(6_000, A), ok(8_000, B), ok(10_000, A), ok(12_000, B), ok(14_000, B), ok(80_000, B)];
    const [release, ...rest] = detectReleases(samples);
    expect(rest).toEqual([]);
    expect(release).toMatchObject({ index: 1, shape: "overlap", commitChanged: true, lastOldOnlyAt: 2_000, firstNewAt: 4_000, lastOldAt: 10_000,
      overlapWindow: { from: 4_000, to: 10_000 }, failedRequests: 0, timeToFirstNewMs: 2_000, settled: true });
  });

  it("sees a stop-then-start swap as a gap of failures before the new build answers", () => {
    const samples = [ok(0, A), ok(2_000, A), fail(4_000), fail(6_000, null), fail(8_000, 503), ok(10_000, B, 2_500), ok(12_000, B)];
    const [release] = detectReleases(samples, { now: 100_000 });
    expect(release).toMatchObject({ shape: "stop_then_start", overlapWindow: null, failedRequests: 3, firstFailureAt: 4_000, timeToFirstNewMs: 6_000,
      slowRequests: 1, lastOldAt: 2_000 });
  });

  it("counts each release once across a series, including a restart on the same commit, and does not settle an open one", () => {
    const samples = [ok(0, A), ok(2_000, B), ok(4_000, A), ok(6_000, B), ok(100_000, B), ok(102_000, C), ok(104_000, B), ok(106_000, C)];
    const releases = detectReleases(samples, { now: 110_000 });
    expect(releases.map(release => [release.index, release.shape, release.commitChanged, release.settled])).toEqual([
      [1, "overlap", true, true], [2, "overlap", false, false]]);
  });

  it("ignores failed samples when no build has answered yet, and reports none for a steady instance", () => {
    expect(detectReleases([fail(0), ok(2_000, A), ok(4_000, A)])).toEqual([]);
    expect(detectReleases([])).toEqual([]);
  });

  it("reports probe continuity: requests, failures, slow answers and the longest gap between answers", () => {
    const report = continuity([ok(0, A), ok(2_000, A), fail(4_000), fail(6_000), ok(9_000, B, 3_000), ok(11_000, B)]);
    expect(report).toEqual({ requests: 6, failures: 2, slow: 1, longestGapMs: 7_000, longestGap: { from: 2_000, to: 9_000 } });
    const lines = releaseMarkdown(detectReleases([ok(0, A), ok(2_000, B), ok(4_000, A), ok(6_000, B)]), report, continuity([]));
    expect(lines[0]).toBe("Health probe: 6 requests, 2 failed, 1 slow, longest gap between answers 7.0 s.");
    expect(lines.at(-1)).toMatch(/^\| 1 \| overlap \| aaaaaaaaa → bbbbbbbbb \|/);
  });
});
