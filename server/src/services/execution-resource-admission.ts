import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";

interface ResourceDemand {
  pool: string;
  cpu: number;
  memoryMb: number;
  provider: string;
}

interface ResourceCapacity {
  cpu: number;
  memoryMb: number;
  providers: Record<string, number>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function readExecutionResourceRequest(config: unknown): ResourceDemand | null {
  if (!record(config) || config.executionResources === undefined) return null;
  const value = config.executionResources;
  if (!record(value) || typeof value.pool !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.pool)
    || typeof value.provider !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.provider)
    || !positive(value.cpu) || !positive(value.memoryMb) || !Number.isSafeInteger(value.memoryMb)) {
    throw new Error("Invalid executionResources: expected pool, provider, positive cpu and integer memoryMb");
  }
  return { pool: value.pool, provider: value.provider, cpu: value.cpu, memoryMb: value.memoryMb };
}

function poolCapacity(env: Record<string, string | undefined>, pool: string): ResourceCapacity {
  let pools: unknown;
  try { pools = JSON.parse(env.PAPERCLIP_EXECUTION_RESOURCE_POOLS ?? "{}"); }
  catch { throw new Error("PAPERCLIP_EXECUTION_RESOURCE_POOLS must be a JSON object"); }
  const value = record(pools) && Object.hasOwn(pools, pool) ? pools[pool] : null;
  if (!record(value) || !positive(value.cpu) || !positive(value.memoryMb)
    || !Number.isSafeInteger(value.memoryMb) || !record(value.providers)
    || Object.values(value.providers).some((limit) => !positive(limit) || !Number.isSafeInteger(limit))) {
    throw new Error(`Missing or invalid operator capacity for execution resource pool ${pool}`);
  }
  return { cpu: value.cpu, memoryMb: value.memoryMb, providers: value.providers as Record<string, number> };
}

/** Must run in the same transaction as queued -> running. Capacity is reserved by
 * the running row, released by terminal disposition, and recovered by native run
 * reconciliation. A physical-pool lock also accounts for other companies. */
export async function canAdmitExecutionResources(
  tx: Db,
  agent: typeof agents.$inferSelect,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const demand = readExecutionResourceRequest(agent.runtimeConfig);
  if (!demand) return true;
  const capacity = poolCapacity(env, demand.pool);
  if (!Object.hasOwn(capacity.providers, demand.provider)) {
    throw new Error(`No operator provider limit for ${demand.provider} in ${demand.pool}`);
  }
  // Pools model a physical execution host, so the lock and accounting span
  // companies sharing that host. This helper never acquires a company lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution-resources:${demand.pool}`}, 0))`);
  const active = await tx.select({ runtimeConfig: agents.runtimeConfig, context: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.status, "running"),
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'executionResourceReservation'->>'pool', ${agents.runtimeConfig}->'executionResources'->>'pool') = ${demand.pool}`,
    ));
  let cpu = demand.cpu;
  let memoryMb = demand.memoryMb;
  let providerRuns = 1;
  for (const run of active) {
    const reserved = record(run.context) && Object.hasOwn(run.context, "executionResourceReservation")
      ? run.context.executionResourceReservation === null ? null
        : readExecutionResourceRequest({ executionResources: run.context.executionResourceReservation })
      : readExecutionResourceRequest(run.runtimeConfig);
    if (!reserved || reserved.pool !== demand.pool) continue;
    cpu += reserved.cpu;
    memoryMb += reserved.memoryMb;
    if (reserved.provider === demand.provider) providerRuns++;
  }
  return cpu <= capacity.cpu && memoryMb <= capacity.memoryMb
    && providerRuns <= capacity.providers[demand.provider]!;
}
