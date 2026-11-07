import { agents, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, decodeHarnessPoolConfig, harnessPoolToRuntimeConfig, type HarnessPool, type HarnessPoolConfigV2 } from "@paperclipai/shared";
import type { ConnectionManagementContext } from "./connection-management.js";
import { aiConnectionRouterService } from "./ai-connection-router.js";
import { conflict, notFound, unprocessable } from "../errors.js";

export function harnessPoolService(db: Db) {
  const pools = aiConnectionRouterService(db);
  async function list(companyId: string): Promise<HarnessPool[]> {
    return (await pools.list(companyId)).filter(pool => pool.kind === "harness_pool" && pool.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY).map(pool => {
      const { id: _id, companyId: _companyId, pluginKey: _pluginKey, revision: _revision, ...stored } = pool;
      const decoded = decodeHarnessPoolConfig(stored);
      if (decoded.kind !== "harness_pool") throw new Error("Invalid harness pool record");
      return { ...decoded.config, id: pool.id, companyId, revision: pool.revision };
    });
  }
  async function choices(companyId: string, userId: string) {
    return (await pools.selectable(companyId, userId, true)).filter(pool => pool.kind === "harness_pool" && pool.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY)
      .map(({ id, name, enabled, revision }) => ({ id, name, enabled, revision }));
  }
  async function get(companyId: string, poolId: string) {
    const pool = (await list(companyId)).find(item => item.id === poolId);
    if (!pool) throw notFound("Harness pool not found");
    return pool;
  }
  async function save(companyId: string, input: { id?: string; expectedRevision?: number; config: HarnessPoolConfigV2 }, userId: string, context?: ConnectionManagementContext) {
    if (input.id) await get(companyId, input.id);
    const saved = await pools.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { ...input, companyId, config: harnessPoolToRuntimeConfig(input.config) }, userId, context);
    return get(companyId, saved.id);
  }
  async function inspect(companyId: string, poolId: string, userId: string) {
    await get(companyId, poolId);
    const usedBy = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId),
      sql`${agents.runtimeConfig}->'harnessPool'->>'poolId' = ${poolId}`));
    return { members: await pools.inspect(companyId, poolId, userId), usedBy };
  }
  async function archive(companyId: string, poolId: string, revision: number, userId: string, context?: ConnectionManagementContext) {
    await get(companyId, poolId);
    return pools.remove(companyId, poolId, revision, userId, context);
  }
  async function convertV1(companyId: string, poolId: string, revision: number, preview: boolean, userId: string, context?: ConnectionManagementContext) {
    const old = (await pools.list(companyId)).find(pool => pool.id === poolId);
    if (!old) throw notFound("Connection pool not found");
    if (old.revision !== revision) throw conflict("Pool changed; reload before converting");
    if (old.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || old.kind || old.mode !== "failover") throw unprocessable("Only legacy built-in ordered pools can be converted");
    const decoded = decodeHarnessPoolConfig({ name: old.name, enabled: old.enabled, mode: old.mode, thresholdPercent: old.thresholdPercent,
      members: old.members, schemaVersion: 2, kind: "harness_pool" });
    if (decoded.kind !== "harness_pool") throw new Error("Invalid conversion");
    if (preview) return { ...decoded.config, id: old.id, companyId, revision: old.revision };
    await pools.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, id: poolId, expectedRevision: revision, config: harnessPoolToRuntimeConfig(decoded.config) }, userId, context);
    return get(companyId, poolId);
  }
  return { list, choices, get, save, inspect, archive, convertV1 };
}
