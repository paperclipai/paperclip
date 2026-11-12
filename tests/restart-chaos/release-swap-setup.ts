import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { ChaosApi } from "./api.js";
import { PREP_PROBE_CAP, PROBE_AGENT_CONCURRENCY, ReleaseSwapDriver, hireProbeAgents, homeCleanupPlugin, pgRunReader } from "./release-swap-driver.js";
import type { ReleaseSwapOptions } from "./release-swap-schedule.js";
import { waitForAgentsReady, type ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type { AdapterId, EnvironmentKind } from "./types.js";
import type { Db } from "../../packages/db/src/index.js";

const run = promisify(execFile);

export const DAYTONA_PROBE_SHAPE = { concurrency: 4, prepIntervalMs: 20_000, prepProbeCap: 8 };
export const LOCAL_PROBE_SHAPE = { concurrency: PROBE_AGENT_CONCURRENCY, prepIntervalMs: 2_000, prepProbeCap: PREP_PROBE_CAP };

export async function diskUsageKb(directory: string): Promise<number | null> {
  try {
    const { stdout } = await run("du", ["-sk", directory], { timeout: 60_000 });
    return Number(stdout.trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

export async function startReleaseSwap(input: { options: ReleaseSwapOptions; env: EnvironmentKind; adapters: readonly AdapterId[]; lab: ChaosLab;
  api: ChaosApi; db: Db; timeline: Timeline; temporaryRoot: string; freshHome: boolean; cancelled: () => boolean }): Promise<ReleaseSwapDriver> {
  const shape = input.env === "daytona" ? DAYTONA_PROBE_SHAPE : LOCAL_PROBE_SHAPE;
  const record = (kind: string, data: Record<string, unknown>) => { input.timeline.add(kind, data); };
  const agents = Object.fromEntries(input.adapters.flatMap(adapter => input.lab.agents[adapter] ? [[adapter, input.lab.agents[adapter]]] : []));
  const probeAgents = await hireProbeAgents(input.api, input.lab.companyId, agents, shape.concurrency);
  await waitForAgentsReady(input.api, probeAgents, input.timeline, input.env === "daytona" ? 10 * 60_000 : undefined, 1_000, input.cancelled);
  record("release_swap_probe_agents", { agents: Object.fromEntries(Object.entries(probeAgents).map(([adapter, agent]) => [adapter, agent!.id])),
    maxConcurrentRuns: shape.concurrency, prepIntervalMs: shape.prepIntervalMs, prepProbeCap: shape.prepProbeCap });
  const driver = new ReleaseSwapDriver({ options: input.options, companyId: input.lab.companyId, adapters: input.adapters, agents: input.lab.agents,
    probeAgents, prepIntervalMs: shape.prepIntervalMs, prepProbeCap: shape.prepProbeCap, reader: pgRunReader(input.db), record });
  driver.plugins.push(homeCleanupPlugin({ temporaryRoot: input.temporaryRoot, freshHome: input.freshHome,
    remove: directory => rm(directory, { recursive: true, force: true }), diskUsageKb, record }));
  return driver;
}
