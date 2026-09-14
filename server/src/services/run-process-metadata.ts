import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED } from "./native-local-process-stop.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { isRemoteProcessIdentity, type AdapterProcessSpawnMetadata } from "@paperclipai/adapter-utils";
import { readProcessStartedAt } from "./hot-restart.js";

/** Keep host observations and provider process identities in distinct namespaces. */
export async function persistHeartbeatRunProcessMetadata(
  db: Db,
  runId: string,
  meta: AdapterProcessSpawnMetadata,
  environmentLeaseId?: string,
) {
  const remote = meta.processLocation === "remote";
  if (meta.remoteProcessIdentity && (!remote || !isRemoteProcessIdentity(meta.remoteProcessIdentity)
    || meta.remoteProcessIdentity.pid !== meta.pid || !environmentLeaseId)) {
    throw new Error("Invalid remote process ownership receipt");
  }
  // A remote PID may coincidentally exist on this machine. Never use its host
  // start time, and never publish its process group as a host signalling target.
  const observedStartedAt = remote ? null : await readProcessStartedAt(meta.pid).catch(() => null);
  const startedAt = new Date(observedStartedAt ?? meta.startedAt);
  return db.transaction(async (tx) => {
    const [run] = await tx.update(heartbeatRuns).set({
      processPid: meta.pid,
      processLocation: remote ? "remote" : "local",
      processGroupId: remote ? null : meta.processGroupId,
      processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, runId)).returning();
    if (run?.runtimeMode === "native") await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: run.companyId, runId, agentId: run.agentId,
      eventType: PROCESS_IDENTITY_RECORDED, stream: "system", level: "info",
      message: "Process identity recorded; prior stop evidence no longer applies.",
    });
    if (!run || !meta.remoteProcessIdentity) return run ?? null;
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, environmentLeaseId!), eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.status, "active"),
    )).for("update");
    const boundary = lease?.metadata?.runtimeServiceBoundary as { provider?: unknown; workspaceRoot?: unknown } | undefined;
    if (run.status !== "running" || !lease?.providerLeaseId || boundary?.provider !== "daytona"
      || typeof boundary.workspaceRoot !== "string" || !boundary.workspaceRoot.startsWith("/")) {
      throw new Error("Remote process ownership requires the active run's Daytona execution boundary");
    }
    const runtimeServiceProcessOwner = {
      version: 1, provider: "daytona", runId: run.id, providerLeaseId: lease.providerLeaseId,
      environmentLeaseId: lease.id, workspaceRoot: boundary.workspaceRoot,
      process: meta.remoteProcessIdentity,
    };
    await tx.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeServiceProcessOwner })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(environmentLeases.id, lease.id));
    return run;
  });
}

/** Missing legacy lease history remains unknown (null), never local.
 * Older rows lack an explicit namespace. Use their host-owned lease history
 * before allowing a persisted identifier to reach a local process probe. */
export async function heartbeatRunProcessLocation(db: Pick<Db, "select">, run: {
  id: string; companyId: string; processLocation?: "local" | "remote" | null;
}): Promise<"local" | "remote" | null> {
  return (await heartbeatRunProcessLocations(db, run.companyId, [run])).get(run.id)!;
}

export async function heartbeatRunProcessLocations(db: Pick<Db, "select">, companyId: string, runs: readonly {
  id: string; processLocation?: "local" | "remote" | null;
}[]): Promise<Map<string, "local" | "remote" | null>> {
  const locations = new Map<string, "local" | "remote" | null>(runs.map(run => [run.id, run.processLocation ?? null]));
  const unresolved = runs.filter(run => !run.processLocation).map(run => run.id);
  if (!unresolved.length) return locations;
  const leases = await db.select({ runId: environmentLeases.heartbeatRunId, provider: environmentLeases.provider, metadata: environmentLeases.metadata, driver: environments.driver })
    .from(environmentLeases).leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.heartbeatRunId, unresolved)));
  for (const lease of leases) {
    const boundary = lease.metadata?.runtimeServiceBoundary as { provider?: unknown } | undefined;
    const remote = Boolean(lease.metadata?.runtimeServiceProcessOwner)
      || (boundary?.provider !== undefined && boundary.provider !== "local")
      || (lease.provider !== null && lease.provider !== "local")
      || (lease.driver !== null && lease.driver !== "local");
    if (lease.runId && (remote || locations.get(lease.runId) !== "remote")) locations.set(lease.runId, remote ? "remote" : "local");
  }
  return locations;
}

/** An unknown stored PID must never authorize a host probe. A run with no
 * process identifiers and no remote lease has no host process to verify. */
export async function heartbeatRunRequiresProviderProcessVerification(db: Pick<Db, "select">, run: {
  id: string; companyId: string; processLocation?: "local" | "remote" | null;
  processPid?: number | null; processGroupId?: number | null;
}) {
  const location = await heartbeatRunProcessLocation(db, run);
  return location === "remote" || (location === null && Boolean(run.processPid || run.processGroupId));
}
