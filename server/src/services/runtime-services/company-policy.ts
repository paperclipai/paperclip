import { createHash } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  activityLog, companies, runtimeServiceAllocations, runtimeServiceCompanyPolicies,
  runtimeServiceCompanyPolicyEvents, runtimeServices, type Db,
} from "@paperclipai/db";
import {
  runtimeServiceCompanyPolicyConfigSchema, type RuntimeServiceCompanyPolicy,
  type RuntimeServiceCompanyPolicyConfig, type UpdateRuntimeServiceCompanyPolicy,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import type { RuntimeServiceActor } from "./manager.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof runtimeServices.$inferSelect;
type Reader = Pick<Db, "select">;

/** Acquire before any service/allocation row locks, never around provider RPCs. */
export async function lockRuntimeServiceCompany(tx: Transaction, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`runtime-service-company:${companyId}`}))`);
}

export function reservesRunningCapacity(row: Pick<Row, "desiredState" | "processRef" | "processHandoff">) {
  return row.desiredState === "running" || row.processHandoff?.phase === "pending" || Boolean(row.processRef && !row.processRef.retired && typeof row.processRef.generation === "string");
}
const reserved = sql`(${runtimeServices.desiredState} = 'running' OR ${runtimeServices.processHandoff}->>'phase' = 'pending' OR (${runtimeServices.processRef}->>'generation' IS NOT NULL AND coalesce(${runtimeServices.processRef}->>'retired', 'false') <> 'true'))`;
const retainedAllocation = sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`;

export async function readRuntimeServiceCompanyPolicy(db: Reader, companyId: string) {
  const [row] = await db.select().from(runtimeServiceCompanyPolicies).where(eq(runtimeServiceCompanyPolicies.companyId, companyId));
  return { companyId, revision: row?.revision ?? 0, config: runtimeServiceCompanyPolicyConfigSchema.parse(row?.config ?? {}), updatedAt: row?.updatedAt.toISOString() ?? null };
}

/** Call only while holding the company lock. Stopping processes still count. */
export async function assertRuntimeServiceCapacity(tx: Transaction, companyId: string, options: { running?: boolean; allocation?: boolean; alreadyReserved?: boolean }) {
  const { config } = await readRuntimeServiceCompanyPolicy(tx, companyId);
  if (options.running && config.maxRunningServices !== null) {
    const [usage] = await tx.select({ total: count() }).from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), reserved));
    if (usage!.total + (options.alreadyReserved ? 0 : 1) > config.maxRunningServices) throw conflict(`Company running-service limit reached (${config.maxRunningServices}). Stop a service and wait for it to finish stopping, or ask an operator to raise the limit.`);
  }
  if (options.allocation && config.maxServiceAllocations !== null) {
    const [usage] = await tx.select({ total: count() }).from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), retainedAllocation));
    if (usage!.total >= config.maxServiceAllocations) throw conflict(`Company retained-allocation limit reached (${config.maxServiceAllocations}). Reuse an existing workspace allocation or ask an operator to raise the limit. Stopping a service retains its allocation.`);
  }
  return config;
}

export function createRuntimeServiceCompanyPolicyStore(db: Db, options: {
  now: () => Date;
  auditStop: (tx: Transaction, row: Row, actor: RuntimeServiceActor) => Promise<void>;
}) {
  async function get(companyId: string): Promise<RuntimeServiceCompanyPolicy> {
    return db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      if (!(await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)))[0]) throw notFound("Company not found");
      const policy = await readRuntimeServiceCompanyPolicy(tx, companyId);
      const [running] = await tx.select({ total: count() }).from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), reserved));
      const [allocations] = await tx.select({ total: count() }).from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), retainedAllocation));
      return { ...policy, usage: { runningServices: running!.total, serviceAllocations: allocations!.total } };
    });
  }
  async function update(companyId: string, actor: RuntimeServiceActor, input: UpdateRuntimeServiceCompanyPolicy) {
    if (actor.type !== "board") throw forbidden("Only an operator can change company service limits");
    const requestKey = `${actor.type}:${actor.id}:${input.requestId}`;
    const inputHash = createHash("sha256").update(JSON.stringify(Object.entries(input.config).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    await db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      if (!(await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)))[0]) throw notFound("Company not found");
      const [prior] = await tx.select().from(runtimeServiceCompanyPolicyEvents).where(and(eq(runtimeServiceCompanyPolicyEvents.companyId, companyId), eq(runtimeServiceCompanyPolicyEvents.requestKey, requestKey)));
      if (prior) {
        if (prior.inputHash !== inputHash) throw conflict("This request ID was already used for a different company policy change");
        return;
      }
      const previous = await readRuntimeServiceCompanyPolicy(tx, companyId);
      if (previous.revision !== input.expectedRevision) throw conflict("Company policy changed; refresh before retrying", { revision: previous.revision });
      const config = runtimeServiceCompanyPolicyConfigSchema.parse({ ...previous.config, ...input.config });
      const revision = previous.revision + 1;
      await tx.insert(runtimeServiceCompanyPolicies).values({ companyId, config, revision, updatedAt: options.now() })
        .onConflictDoUpdate({ target: runtimeServiceCompanyPolicies.companyId, set: { config, revision, updatedAt: options.now() } });
      // Retained files are never evicted by lowering a cap. Existing stopping
      // processes consume admission slots until termination. Do not evict more
      // services merely because a previous limit change is still stopping them.
      const rows = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), reserved)).orderBy(asc(runtimeServices.createdAt), asc(runtimeServices.id)).for("update");
      let remaining = config.maxRunningServices ?? Infinity;
      const stopped: string[] = [];
      for (const row of rows) {
        if (row.desiredState !== "running") continue;
        const expired = config.maxRunningSeconds !== null && row.startedAt !== null && options.now().getTime() - row.startedAt.getTime() >= config.maxRunningSeconds * 1000;
        if (!expired && remaining-- > 0) continue;
        const [next] = await tx.update(runtimeServices).set({ desiredState: "stopped", state: "stopping", stopReason: expired ? "company_maximum_lifetime" : "company_running_limit", revision: row.revision + 1, updatedAt: options.now() }).where(eq(runtimeServices.id, row.id)).returning();
        await options.auditStop(tx, next!, actor);
        stopped.push(row.id);
      }
      await tx.insert(runtimeServiceCompanyPolicyEvents).values({ companyId, requestKey, inputHash, revision });
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: actor.id, action: "runtime_service.company_policy_changed", entityType: "company", entityId: companyId, details: { revision, config, stoppedServiceIds: stopped } });
    });
    return get(companyId);
  }
  return { get, update };
}
