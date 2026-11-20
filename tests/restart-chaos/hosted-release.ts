export interface HealthSample {
  at: number;
  ok: boolean;
  status: number | null;
  ms: number;
  processStartedAt: string | null;
  commit: string | null;
  error?: string | null;
}

export type ReleaseShape = "overlap" | "stop_then_start" | "clean_switch";

export interface DetectedRelease {
  index: number;
  from: { processStartedAt: string | null; commit: string | null };
  to: { processStartedAt: string | null; commit: string | null };
  commitChanged: boolean;
  lastOldOnlyAt: number;
  firstNewAt: number;
  lastOldAt: number;
  overlapWindow: { from: number; to: number } | null;
  shape: ReleaseShape;
  failedRequests: number;
  slowRequests: number;
  firstFailureAt: number | null;
  timeToFirstNewMs: number;
  settled: boolean;
}

export interface ContinuityReport {
  requests: number;
  failures: number;
  slow: number;
  longestGapMs: number;
  longestGap: { from: number; to: number } | null;
}

export const SLOW_REQUEST_MS = 2_000;
export const RELEASE_SETTLE_MS = 60_000;

export const identityOf = (sample: Pick<HealthSample, "processStartedAt" | "commit">) => `${sample.commit ?? "?"}@${sample.processStartedAt ?? "?"}`;

export function detectReleases(samples: readonly HealthSample[], options: { slowMs?: number; settleMs?: number; now?: number } = {}): DetectedRelease[] {
  const slowMs = options.slowMs ?? SLOW_REQUEST_MS;
  const settleMs = options.settleMs ?? RELEASE_SETTLE_MS;
  const sorted = [...samples].sort((left, right) => left.at - right.at);
  const now = options.now ?? sorted.at(-1)?.at ?? 0;
  const releases: DetectedRelease[] = [];
  let current: HealthSample | null = null;
  let lastCurrentOnlyAt: number | null = null;
  const retired = new Set<string>();
  for (let position = 0; position < sorted.length; position += 1) {
    const sample = sorted[position]!;
    if (!sample.ok || !sample.processStartedAt) continue;
    if (!current) { current = sample; lastCurrentOnlyAt = sample.at; continue; }
    const identity = identityOf(sample);
    if (identity === identityOf(current)) { lastCurrentOnlyAt = sample.at; continue; }
    if (retired.has(identity)) continue;
    const oldIdentity = identityOf(current);
    const firstNewAt = sample.at;
    const later = sorted.slice(position);
    const oldAnswers = later.filter(entry => entry.ok && identityOf(entry) === oldIdentity);
    const lastOldAt = oldAnswers.length ? oldAnswers.at(-1)!.at : lastCurrentOnlyAt!;
    const windowFrom = lastCurrentOnlyAt!;
    const windowTo = Math.max(firstNewAt, lastOldAt);
    const inWindow = sorted.filter(entry => entry.at > windowFrom && entry.at <= windowTo + settleMs);
    const failures = inWindow.filter(entry => !entry.ok);
    const failedBeforeNew = sorted.filter(entry => entry.at > windowFrom && entry.at < firstNewAt && !entry.ok);
    const overlap = lastOldAt > firstNewAt ? { from: firstNewAt, to: lastOldAt } : null;
    const shape: ReleaseShape = overlap && failures.length === 0 ? "overlap" : failedBeforeNew.length ? "stop_then_start" : overlap ? "overlap" : "clean_switch";
    releases.push({
      index: releases.length + 1,
      from: { processStartedAt: current.processStartedAt, commit: current.commit },
      to: { processStartedAt: sample.processStartedAt, commit: sample.commit },
      commitChanged: current.commit !== sample.commit,
      lastOldOnlyAt: windowFrom, firstNewAt, lastOldAt, overlapWindow: overlap, shape,
      failedRequests: failures.length,
      slowRequests: inWindow.filter(entry => entry.ok && entry.ms >= slowMs).length,
      firstFailureAt: failures[0]?.at ?? null,
      timeToFirstNewMs: firstNewAt - (failedBeforeNew[0]?.at ?? windowFrom),
      settled: now >= windowTo + settleMs,
    });
    retired.add(oldIdentity);
    current = sample;
    lastCurrentOnlyAt = sample.at;
  }
  return releases;
}

export function continuity(samples: readonly HealthSample[], slowMs = SLOW_REQUEST_MS): ContinuityReport {
  const sorted = [...samples].sort((left, right) => left.at - right.at);
  let previousOk: number | null = null;
  let longest: { from: number; to: number } | null = null;
  for (const sample of sorted) {
    if (!sample.ok) continue;
    if (previousOk !== null && (!longest || sample.at - previousOk > longest.to - longest.from)) longest = { from: previousOk, to: sample.at };
    previousOk = sample.at;
  }
  return { requests: sorted.length, failures: sorted.filter(sample => !sample.ok).length, slow: sorted.filter(sample => sample.ok && sample.ms >= slowMs).length,
    longestGapMs: longest ? longest.to - longest.from : 0, longestGap: longest };
}

export function releaseMarkdown(releases: readonly DetectedRelease[], health: ContinuityReport, api: ContinuityReport): string[] {
  const iso = (at: number | null) => at === null ? "–" : new Date(at).toISOString();
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return [
    `Health probe: ${health.requests} requests, ${health.failures} failed, ${health.slow} slow, longest gap between answers ${seconds(health.longestGapMs)}.`,
    `API requests: ${api.requests} requests, ${api.failures} failed, ${api.slow} slow, longest gap between answers ${seconds(api.longestGapMs)}.`,
    "",
    "| Release | Shape | Commit changed | New build first answered | Old build last answered | Two builds answering | Failed | Slow | Time to first new answer |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...releases.map(release => `| ${release.index} | ${release.shape} | ${release.commitChanged ? `${release.from.commit?.slice(0, 9) ?? "?"} → ${release.to.commit?.slice(0, 9) ?? "?"}` : "no"} | `
      + `${iso(release.firstNewAt)} | ${iso(release.lastOldAt)} | ${release.overlapWindow ? seconds(release.overlapWindow.to - release.overlapWindow.from) : "none"} | `
      + `${release.failedRequests} | ${release.slowRequests} | ${seconds(release.timeToFirstNewMs)} |`),
  ];
}
