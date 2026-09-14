import path from "node:path";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { runtimeServiceAllocations, runtimeServices, type Db } from "@paperclipai/db";
import { runtimeServiceStorageUsageSchema, type RuntimeServiceStorageUsage, type RuntimeServiceStorageView } from "@paperclipai/shared";
import { notFound } from "../../errors.js";
import type { RuntimeServiceProvider } from "./provider.js";

export const emptyRuntimeServiceStorage: RuntimeServiceStorageUsage = { status: "unmeasured", bytes: null, measuredAt: null, checkedAt: null, reason: null };
const MEASUREMENT_INTERVAL = 5 * 60_000;

/** Measurements use their own lock, so slow scans never lock service controls. */
export function createRuntimeServiceStorageStore(db: Db, providers: Map<string, RuntimeServiceProvider>, now: () => Date) {
  async function view(companyId: string, allocationId: string): Promise<RuntimeServiceStorageView> {
    const [allocation] = await db.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
    if (!allocation) throw notFound("Service storage not found");
    const where = and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocationId));
    const [[total], services] = await Promise.all([
      db.select({ count: count() }).from(runtimeServices).where(where),
      db.select({ id: runtimeServices.id, name: runtimeServices.name, state: runtimeServices.state }).from(runtimeServices).where(where).orderBy(asc(runtimeServices.createdAt)).limit(10),
    ]);
    return { allocationId, usage: allocation.storageUsage ?? emptyRuntimeServiceStorage, serviceCount: total?.count ?? 0,
      services: services as RuntimeServiceStorageView["services"] };
  }
  async function refresh(companyId: string, allocationId: string, minimumAgeMs = 2_000) {
    await db.transaction(async (tx) => {
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-storage:${companyId}:${allocationId}`})) as acquired`);
      if (!lock[0]?.acquired) return;
      const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
      if (!allocation) throw notFound("Service storage not found");
      if (allocation.dataDeletionId) return;
      const prior = allocation.storageUsage ?? emptyRuntimeServiceStorage;
      if (prior.checkedAt && now().getTime() - Date.parse(prior.checkedAt) < minimumAgeMs) return;
      const [service] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.allocationId, allocationId))).orderBy(asc(runtimeServices.createdAt)).limit(1);
      if (!service) return;
      const provider = providers.get(allocation.provider);
      let usage: RuntimeServiceStorageUsage = { ...prior, status: "unavailable", checkedAt: now().toISOString(), reason: "measurement_failed" };
      if (allocation.metadata.allocationRequest && !allocation.metadata.provisionedAt) usage.reason = "not_provisioned";
      else if (!provider?.storageUsage) usage.reason = "unsupported";
      else {
        const boundary = (allocation.provider === "local" ? allocation.metadata.localBoundary : allocation.metadata.executionBoundary) as { workspaceRoot?: string } | undefined;
        const root = boundary?.workspaceRoot ?? allocation.cwd;
        try {
          if (!(allocation.provider === "local" ? path.isAbsolute(root) : path.posix.isAbsolute(root))) throw new Error("Invalid storage root");
          const result = await provider.storageUsage({ companyId, serviceId: service.id, allocationId,
            environmentLeaseId: allocation.environmentLeaseId, allocationMetadata: allocation.metadata,
            spec: { ...service.spec, cwd: root, env: {}, command: "", endpoints: [] }, env: {}, secrets: [],
            process: { generation: String(service.processRef?.generation ?? service.id) },
          });
          if ("bytes" in result) usage = { status: "ready", bytes: result.bytes, measuredAt: now().toISOString(), checkedAt: now().toISOString(), reason: null };
          else usage.reason = result.unavailable;
          usage = runtimeServiceStorageUsageSchema.parse(usage);
        } catch { usage = { ...prior, status: "unavailable", checkedAt: now().toISOString(), reason: "measurement_failed" }; }
      }
      // This column is independent from lifecycle metadata and revisions. A
      // measurement finishing after Stop cannot restore old control state.
      await tx.update(runtimeServiceAllocations).set({ storageUsage: usage }).where(and(eq(runtimeServiceAllocations.id, allocationId), eq(runtimeServiceAllocations.companyId, companyId)));
    });
    return view(companyId, allocationId);
  }
  async function tick() {
    const candidates = await db.select({ companyId: runtimeServiceAllocations.companyId, id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
      .where(and(isNull(runtimeServiceAllocations.dataDeletionId), sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`,
        sql`(${runtimeServiceAllocations.storageUsage}->>'checkedAt' IS NULL OR (${runtimeServiceAllocations.storageUsage}->>'checkedAt')::timestamptz < ${new Date(now().getTime() - MEASUREMENT_INTERVAL).toISOString()}::timestamptz)`))
      .orderBy(sql`${runtimeServiceAllocations.storageUsage}->>'checkedAt' ASC NULLS FIRST`, asc(runtimeServiceAllocations.createdAt)).limit(4);
    // Two bounded read-only scans; lifecycle reconciliation has separate queues.
    for (let offset = 0; offset < candidates.length; offset += 2) await Promise.allSettled(candidates.slice(offset, offset + 2).map((candidate) => refresh(candidate.companyId, candidate.id, MEASUREMENT_INTERVAL)));
  }
  return { view, refresh, tick };
}
