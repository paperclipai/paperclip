import type { IdlePluginCatalogEntry } from "./plugin-idle-catalog.js";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { VerifiedIdleCapabilities } from "./idle-incoming-wake-capability.js";
import type { ScheduledWake } from "./idle-scheduled-work.js";
import { IDLE_DEADLINE_CATALOG, type DomainScheduledWake, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";
import { readIdleAgentTimerSchedule } from "./heartbeat/idle-timer-schedule.js";
import { readIdlePluginJobSchedule } from "./plugin-job-idle-schedule.js";
import { readIdleProviderTraceSchedule } from "./provider-trace-idle-schedule.js";
import { readIdleGitHubGrantContinuity } from "./tool-access/github-grant-continuity.js";

const processGeneration = randomUUID();
export class IdleDeadlineInspectionBudgetExceeded extends Error {}
export function createIdleDeadlineInspectionBudget(now: number, expiresAt: number,
  monotonicNow: () => number = () => performance.now()) {
  const started = monotonicNow();
  const elapsedLimit = Math.min(2_000, expiresAt - now - 60_000);
  let queries = 0;
  const check = () => {
    if (!Number.isFinite(elapsedLimit) || elapsedLimit <= 0 || monotonicNow() - started >= elapsedLimit)
      throw new IdleDeadlineInspectionBudgetExceeded("Idle deadline inspection exhausted its time budget");
  };
  return { check, beforeQuery() {
    check();
    if (++queries > 64) throw new IdleDeadlineInspectionBudgetExceeded("Idle deadline inspection exhausted its query budget");
  }, get queries() { return queries; } };
}
export type IdleDeadlineProof = {
  blocked: boolean;
  generation?: string;
  scheduledWake?: DomainScheduledWake;
  githubContinuity?: { connectionIds: string[]; generation: string };
};
export type IdleDeadlineProofOptions = {
  now: number;
  verifiedCapability?: VerifiedIdleCapabilities;
  quietPluginIds: readonly string[];
  quietPluginGeneration?: string;
  quietPluginCatalog?: readonly IdlePluginCatalogEntry[];
  scheduledWake?: ScheduledWake;
  passiveGeneration?: string;
};
const generation = (state: unknown) => createHash("sha256").update(JSON.stringify(state)).digest("hex");

export function composeIdleDeadlineProof(hold: { ownerId: string; expiresAt: number }, options: IdleDeadlineProofOptions,
  snapshots: { timers: IdleDeadlineSnapshot; jobs: IdleDeadlineSnapshot; traces: IdleDeadlineSnapshot;
    github: IdleDeadlineSnapshot & { connectionIds: string[] } }): IdleDeadlineProof {
  if (!Number.isFinite(options.now) || options.verifiedCapability?.deadlineCatalog !== IDLE_DEADLINE_CATALOG || !hold.ownerId
    || !Number.isFinite(hold.expiresAt) || hold.expiresAt <= options.now
    || Object.values(snapshots).some(snapshot => snapshot.blocked)
    || (options.quietPluginIds.length > 0 && !options.quietPluginGeneration)) return { blocked: true };
  const deadlines = Object.values(snapshots).flatMap(snapshot => snapshot.deadlines);
  if (options.scheduledWake) deadlines.push(Date.parse(options.scheduledWake.nextWakeAt));
  if (deadlines.some(at => !Number.isFinite(at) || at <= options.now)) return { blocked: true };
  const proofGeneration = generation([IDLE_DEADLINE_CATALOG, processGeneration, hold,
    options.quietPluginIds, options.quietPluginGeneration, options.quietPluginCatalog, options.scheduledWake, options.passiveGeneration,
    Object.entries(snapshots).map(([owner, snapshot]) => [owner, snapshot.state, snapshot.deadlines])]);
  const githubContinuity = { connectionIds: snapshots.github.connectionIds,
    generation: generation([proofGeneration, snapshots.github.connectionIds]) };
  return { blocked: false, generation: proofGeneration, githubContinuity,
    ...(deadlines.length ? { scheduledWake: { version: 2, kind: "domain_deadlines", catalog: IDLE_DEADLINE_CATALOG,
      generation: proofGeneration, nextWakeAt: new Date(Math.min(...deadlines)).toISOString() } } : {}) };
}

export async function readIdleDeadlineProof(tx: Pick<Db, "select">, hold: { ownerId: string; expiresAt: number },
  options: IdleDeadlineProofOptions): Promise<IdleDeadlineProof> {
  if (options.verifiedCapability?.deadlineCatalog !== IDLE_DEADLINE_CATALOG) return { blocked: true };
  const budget = createIdleDeadlineInspectionBudget(options.now, hold.expiresAt);
  const guarded = { select: (...args: unknown[]) => {
    budget.beforeQuery();
    return Reflect.apply(tx.select, tx, args);
  } } as Pick<Db, "select">;
  try {
    const timers = await readIdleAgentTimerSchedule(guarded, options.now, process.env, budget.check);
    budget.check();
    if (timers.blocked) return { blocked: true };
    const jobs = await readIdlePluginJobSchedule(guarded, options.quietPluginIds, options.now, options.quietPluginCatalog);
    budget.check();
    if (jobs.blocked) return { blocked: true };
    const traces = await readIdleProviderTraceSchedule(guarded, options.now);
    budget.check();
    if (traces.blocked) return { blocked: true };
    const github = await readIdleGitHubGrantContinuity(guarded, options.now, budget.check);
    budget.check();
    const proof = composeIdleDeadlineProof(hold, options, { timers, jobs, traces, github });
    budget.check();
    return proof;
  } catch (error) {
    if (error instanceof IdleDeadlineInspectionBudgetExceeded) return { blocked: true };
    throw error;
  }
}

export function deadlineWorkReplacement(reason: string): string | undefined {
  if (reason === "agents.execution_or_timer") return `SELECT 1 FROM agents WHERE status = 'running'`;
  if (reason === "plugin_jobs") return `SELECT 1 FROM plugin_jobs WHERE status NOT IN ('active', 'paused')`;
  return undefined;
}
