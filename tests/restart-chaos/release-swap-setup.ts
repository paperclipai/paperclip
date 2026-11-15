import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { ChaosApi } from "./api.js";
import { PREP_PROBE_CAP, PROBE_AGENT_CONCURRENCY, ReleaseSwapDriver, hireProbeAgents, homeCleanupPlugin, pgRunReader } from "./release-swap-driver.js";
import { ReleaseSwapRun, overlapLaunchExtensionMs, type ReleaseSwapOptions } from "./release-swap-schedule.js";
import { finishReleaseSwap, type ReleaseSwapFinishInput } from "./release-swap-finish.js";
import { StormRun } from "./scheduler.js";
import { setOverlapProbe } from "./staging-mix.js";
import { bannerSink } from "./staging-mix-retry.js";
import type { ChaosSupervisor } from "./supervisor.js";
import type { TaskObserver } from "./observer.js";
import { waitForAgentsReady, type ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type { AdapterId, EnvironmentKind, WavePlan } from "./types.js";
import { createDb, type Db } from "../../packages/db/src/index.js";

const run = promisify(execFile);

export const DAYTONA_PROBE_SHAPE = { concurrency: 4, prepIntervalMs: 20_000, prepProbeCap: 8 };
export const LOCAL_PROBE_SHAPE = { concurrency: PROBE_AGENT_CONCURRENCY, prepIntervalMs: 3_000, prepProbeCap: PREP_PROBE_CAP };

export async function diskUsageKb(directory: string): Promise<number | null> {
  try {
    const { stdout } = await run("du", ["-sk", directory], { timeout: 60_000 });
    return Number(stdout.trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

export async function startReleaseSwap(input: { options: ReleaseSwapOptions; env: EnvironmentKind; adapters: readonly AdapterId[]; lab: ChaosLab;
  api: ChaosApi; db: Db; timeline: Timeline; temporaryRoot: string; freshHome: boolean; cancelled: () => boolean }): Promise<{ driver: ReleaseSwapDriver; probesReady: Promise<void> }> {
  const shape = input.env === "daytona" ? DAYTONA_PROBE_SHAPE : LOCAL_PROBE_SHAPE;
  const record = (kind: string, data: Record<string, unknown>) => { input.timeline.add(kind, data); };
  const agents = Object.fromEntries(input.adapters.flatMap(adapter => input.lab.agents[adapter] ? [[adapter, input.lab.agents[adapter]]] : []));
  const probeAgents = await hireProbeAgents(input.api, input.lab.companyId, agents, shape.concurrency);
  const probesReady = waitForAgentsReady(input.api, probeAgents, input.timeline, input.env === "daytona" ? 10 * 60_000 : undefined, 1_000, input.cancelled).then(() => {
    record("release_swap_probe_agents", { agents: Object.fromEntries(Object.entries(probeAgents).map(([adapter, agent]) => [adapter, agent!.id])),
      maxConcurrentRuns: shape.concurrency, prepIntervalMs: shape.prepIntervalMs, prepProbeCap: shape.prepProbeCap });
  });
  probesReady.catch(() => undefined);
  const driver = new ReleaseSwapDriver({ options: input.options, companyId: input.lab.companyId, adapters: input.adapters, agents: input.lab.agents,
    probeAgents, prepIntervalMs: shape.prepIntervalMs, prepProbeCap: shape.prepProbeCap, reader: pgRunReader(input.db), record });
  driver.plugins.push(homeCleanupPlugin({ temporaryRoot: input.temporaryRoot, freshHome: input.freshHome,
    remove: directory => rm(directory, { recursive: true, force: true }), diskUsageKb, record }));
  return { driver, probesReady };
}

export function stormRunFor(plan: WavePlan, now: number): StormRun | ReleaseSwapRun | null {
  if (!plan.storm) return null;
  return plan.options.releaseSwap ? new ReleaseSwapRun(plan.storm, now) : new StormRun(plan.storm, now);
}

export class ReleaseSwapWave {
  private constructor(readonly driver: ReleaseSwapDriver, private readonly db: Db, private readonly plan: WavePlan, private readonly lab: ChaosLab,
    private readonly api: ChaosApi, private readonly timeline: Timeline, private readonly supervisor: Pick<ChaosSupervisor, "serverWindows">,
    private readonly cancelled: () => boolean) {}

  static async start(input: { plan: WavePlan; lab: ChaosLab; api: ChaosApi; timeline: Timeline; databaseUrl: string;
    supervisor: Pick<ChaosSupervisor, "serverWindows" | "swapHook" | "paths">; cancelled: () => boolean }): Promise<ReleaseSwapWave> {
    const options = input.plan.options;
    const db = createDb(input.databaseUrl);
    const { driver, probesReady } = await startReleaseSwap({ options: options.releaseSwap!, env: options.env, adapters: options.adapters, lab: input.lab, api: input.api, db,
      timeline: input.timeline, temporaryRoot: input.supervisor.paths.temporaryRoot, freshHome: options.k15FreshHome === true, cancelled: input.cancelled });
    input.supervisor.swapHook = async info => { await probesReady; return driver.hook(info); };
    setOverlapProbe(() => driver.launchOpen);
    const wave = new ReleaseSwapWave(driver, db, input.plan, input.lab, input.api, input.timeline, input.supervisor, input.cancelled);
    driver.plugins.push({ name: "overlap-launch-deadlines", onPhase: async (_swap, info) => { if (info.phase === "stopped") wave.extendOverlapLaunches(info.at); } });
    return wave;
  }

  private overlapLaunches: Array<{ observer: Pick<TaskObserver, "extendDeadline" | "plan">; at: number }> = [];

  noteLaunch(observer: Pick<TaskObserver, "extendDeadline" | "plan">, at = Date.now()): void {
    if (this.driver.launchOpen) this.overlapLaunches.push({ observer, at });
  }

  extendOverlapLaunches(stoppedAt: number): void {
    for (const { observer, at } of this.overlapLaunches.splice(0)) {
      const ms = overlapLaunchExtensionMs(at, stoppedAt);
      observer.extendDeadline(ms);
      this.timeline.add("release_swap_deadline_extended", { taskId: observer.plan.taskId, ms });
    }
  }

  async finish(input: { board: ReleaseSwapFinishInput["board"]; observers: readonly TaskObserver[]; launched: readonly TaskObserver[]; waveDir: string }): Promise<boolean> {
    const options = this.plan.options.releaseSwap!;
    try {
      const graded = await finishReleaseSwap({ driver: this.driver, settleMs: options.settleMs, companyId: this.lab.companyId, api: this.api, db: this.db, board: input.board,
        drainCapMs: options.drainMs ?? Math.max(0, ...input.observers.map(observer => observer.definition.budgetMs)) + options.settleMs,
        timeline: this.timeline.entries, issueIdForTask: new Map(input.launched.flatMap(observer => observer.record.issueId ? [[observer.plan.taskId, observer.record.issueId] as const] : [])),
        serverWindows: this.supervisor.serverWindows, waveDir: input.waveDir, cancelled: this.cancelled, record: (kind, data) => { this.timeline.add(kind, data); },
        onView: bannerSink(input.launched) });
      return graded.pass;
    } finally {
      setOverlapProbe(null);
      await this.db.$client.end({ timeout: 5 }).catch(() => undefined);
    }
  }
}
