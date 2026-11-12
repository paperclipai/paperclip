import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChaosApi } from "./api.js";
import { apiRequests, HealthProbe, HostedApi, hostedToken, requestSamples, type RequestRecord } from "./hosted-api.js";
import { parseHostedCommand, type HostedOptions } from "./hosted-config.js";
import { gradeHosted } from "./hosted-grade.js";
import { continuity, detectReleases, identityOf, releaseMarkdown, type DetectedRelease, type HealthSample } from "./hosted-release.js";
import { cleanupHosted, inventory, loadState, resolveCompany, setupHosted, type HostedState } from "./hosted-setup.js";
import { HostedWorkload, planHostedTasks, type HostedTaskRecord } from "./hosted-workload.js";
import type { RetryClick } from "./release-swap-grade.js";
import { waitForAgentsReady } from "./seed.js";
import { Timeline } from "./timeline.js";

const resultsRoot = path.resolve(process.env.RESTART_CHAOS_RESULTS_DIR ?? path.join(import.meta.dirname, "results"));
const LOOP_MS = 5_000;
const POLL_MS = 15_000;

export function releasesReached(releases: readonly DetectedRelease[], wanted: number): boolean {
  return wanted > 0 && releases.filter(release => release.settled).length >= wanted;
}

export function arrivalsDone(wanted: number, remaining: number, active: number, releases: readonly DetectedRelease[]): boolean {
  return wanted === 0 ? remaining === 0 && active === 0 : releasesReached(releases, wanted);
}

export function observedClicks(records: readonly HostedTaskRecord[]): Map<string, RetryClick[]> {
  return new Map(records.flatMap(entry => entry.issueId && entry.retryClicks.length ? [[entry.issueId, [...entry.retryClicks]] as const] : []));
}

export function keepPolling(workload: Pick<HostedWorkload, "poll">, pollMs = POLL_MS): { stop: () => Promise<void> } {
  let running = true;
  let wake: (() => void) | null = null;
  const loop = (async () => {
    while (running) {
      await workload.poll().catch(() => undefined);
      if (!running) break;
      await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, pollMs).unref?.(); });
    }
  })();
  return { stop: async () => { running = false; wake?.(); await loop; } };
}

export async function finalizeHosted(input: { api: Parameters<typeof cleanupHosted>[0]["api"]; keep: boolean; label: string; dir: string; state: HostedState | null;
  record: (kind: string, data: Record<string, unknown>) => void; terminatePollMs?: number }): Promise<{ errors: string[] } | null> {
  if (input.keep) return null;
  const state = input.state ?? await loadState(input.dir);
  if (!state) return null;
  return await cleanupHosted({ api: input.api, label: input.label, companyId: state.companyId, state, record: input.record, terminatePollMs: input.terminatePollMs })
    .catch(error => ({ errors: [String(error)] }));
}

function watchIdentity(timeline: Timeline, samplesPath: string) {
  let last: string | null = null;
  let failing = false;
  return (sample: HealthSample) => {
    appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
    if (!sample.ok) {
      if (!failing) timeline.add("hosted_health_failed", { status: sample.status, ms: sample.ms, error: sample.error ?? null });
      failing = true;
      return;
    }
    if (failing) timeline.add("hosted_health_recovered", { ms: sample.ms });
    failing = false;
    const identity = identityOf(sample);
    if (identity !== last) timeline.add("hosted_health_identity", { commit: sample.commit, processStartedAt: sample.processStartedAt, previous: last });
    last = identity;
  };
}

async function observe(options: HostedOptions, probe: HealthProbe, api: HostedApi, dir: string, started: number, cancelled: () => boolean, timeline: Timeline): Promise<number> {
  while (!cancelled() && Date.now() - started < options.maxWaitMs && !releasesReached(detectReleases(probe.samples, { now: Date.now() }), options.releases)) await delay(LOOP_MS);
  await probe.stop();
  const releases = detectReleases(probe.samples, { now: Date.now() });
  const lines = releaseMarkdown(releases, continuity(probe.samples), continuity(requestSamples(apiRequests(api.requests))));
  await writeFile(path.join(dir, "SUMMARY.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
  timeline.add("hosted_observed", { releases: releases.map(release => ({ shape: release.shape, firstNewAt: new Date(release.firstNewAt).toISOString(),
    lastOldAt: new Date(release.lastOldAt).toISOString(), failed: release.failedRequests, commitChanged: release.commitChanged })) });
  console.info(lines.join("\n"));
  return releasesReached(releases, options.releases) ? 0 : 1;
}

export async function runHosted(argv: readonly string[]): Promise<number> {
  const options = parseHostedCommand(argv);
  const dir = path.join(resultsRoot, `hosted-${options.label}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const timeline = new Timeline(path.join(dir, "timeline.jsonl"));
  const record = (kind: string, data: Record<string, unknown>) => { timeline.add(kind, data); };
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const cancelled = () => interrupted;
  const api = new HostedApi(options.target, hostedToken(options.target));
  try {
    const exit = await hostedSession({ options, dir, timeline, record, cancelled, api, interrupted: () => interrupted });
    console.info(`Hosted run ${options.label}: results ${dir}`);
    return exit;
  } finally {
    await saveRequests(dir, api.requests, options.mode);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function requestsFile(mode: HostedOptions["mode"], at = new Date()): string {
  return mode === "run" ? "requests.jsonl" : `requests-${mode}-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

export async function saveRequests(dir: string, requests: readonly RequestRecord[], mode: HostedOptions["mode"] = "run", at = new Date()): Promise<string> {
  const file = path.join(dir, requestsFile(mode, at));
  await writeFile(file, requests.map(entry => JSON.stringify(entry)).join("\n") + (requests.length ? "\n" : ""), { mode: 0o600 });
  return file;
}

async function hostedSession(input: { options: HostedOptions; dir: string; timeline: Timeline; record: (kind: string, data: Record<string, unknown>) => void;
  cancelled: () => boolean; api: HostedApi; interrupted: () => boolean }): Promise<number> {
  const { options, dir, timeline, record, cancelled, api } = input;
  const me = await api.get<{ userId?: string; companyIds?: string[] }>("/api/cli-auth/me");
  timeline.add("hosted_signed_in", { baseUrl: options.target.baseUrl, mode: options.mode, label: options.label, companies: me.companyIds?.length ?? 0 });

  if (options.mode === "cleanup") {
    const state = await loadState(dir);
    const companyId = options.companyId ?? state?.companyId ?? await resolveCompany(api, null);
    const report = await cleanupHosted({ api, label: options.label, companyId, state, record });
    console.info(`Cleanup ${options.label}: ${JSON.stringify(report)}`);
    return report.errors.length ? 1 : 0;
  }

  const census = await inventory(api, options.label);
  timeline.add("hosted_inventory", { ...census });
  const started = Date.now();
  const probe = new HealthProbe(api, options.healthMs, watchIdentity(timeline, path.join(dir, "health.jsonl"))).start();
  if (options.mode === "observe") return await observe(options, probe, api, dir, started, cancelled, timeline);

  let state: HostedState | null = null;
  let polling: { stop: () => Promise<void> } | null = null;
  let exit = 2;
  try {
    const companyId = await resolveCompany(api, options.companyId);
    state = await setupHosted({ api, options, companyId, dir, record });
    await waitForAgentsReady(api as unknown as ChaosApi, Object.fromEntries(Object.entries(state.agents).map(([adapter, agent]) => [adapter, { id: agent!.id }])),
      timeline, 10 * 60_000, 2_000, cancelled);
    const plans = planHostedTasks(options, options.tasks ?? 2_000);
    const workload = new HostedWorkload({ api, label: options.label, companyId, projectId: state.projectId, agents: state.agents, plans,
      concurrency: options.concurrency, record, retryDuringWave: options.retryDuringWave });
    let lastPoll = 0;
    for (;;) {
      const now = Date.now();
      const releases = detectReleases(probe.samples, { now });
      const reached = options.releases === 0 ? workload.remaining === 0 : releases.length >= options.releases;
      if (!reached && !cancelled()) await workload.launchDue(now);
      if (now - lastPoll >= POLL_MS) { lastPoll = now; await workload.poll(now); }
      if (cancelled() || arrivalsDone(options.releases, workload.remaining, workload.active(now).length, releases) || now - started > options.maxWaitMs) break;
      await delay(LOOP_MS);
    }
    for (const entry of workload.records) if (entry.issueId) state.issueIds.push(entry.issueId);
    timeline.add("hosted_arrivals_ended", { launched: workload.launched, releases: detectReleases(probe.samples).length, interrupted: input.interrupted(), timedOut: Date.now() - started > options.maxWaitMs });
    const releases = detectReleases(probe.samples, { now: Date.now() });
    if (options.releases > 0 && !releasesReached(releases, options.releases)) timeline.add("hosted_releases_short", { wanted: options.releases, seen: releases.length });
    polling = keepPolling(workload);
    const graded = await gradeHosted({ api, companyId, agentIds: Object.values(state.agents).map(agent => agent!.id), releases,
      health: () => continuity(probe.samples), apiContinuity: () => continuity(requestSamples(apiRequests(api.requests))), requests: () => api.requests,
      quietMs: options.quietMs,
      stopObserver: () => polling!.stop(), observedClicks: () => observedClicks(workload.records), banners: () => new Map(workload.banners),
      agentNames: Object.values(state.agents).map(agent => agent!.name),
      lastReleaseAt: releases.at(-1)?.lastOldAt ?? Date.now(), settleMs: options.settleMs, drainMs: options.drainMs, dir, cancelled, record });
    console.info(`\n${graded.markdown}`);
    const short = options.releases > 0 && !releasesReached(releases, options.releases);
    exit = graded.pass && !short && !input.interrupted() ? 0 : 1;
  } catch (error) {
    timeline.add("harness_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    console.error(error);
    exit = 2;
  } finally {
    await polling?.stop();
    await probe.stop();
    await writeFile(path.join(dir, "health-summary.json"), `${JSON.stringify({ releases: detectReleases(probe.samples), health: continuity(probe.samples),
      api: continuity(requestSamples(apiRequests(api.requests))), inventory: census }, null, 2)}\n`, { mode: 0o600 });
    const cleaned = await finalizeHosted({ api, keep: options.keep, label: options.label, dir, state, record });
    if (cleaned && cleaned.errors.length) exit = Math.max(exit, 1);
  }
  return exit;
}

