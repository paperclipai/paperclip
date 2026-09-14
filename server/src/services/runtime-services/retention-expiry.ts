import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db, type runtimeServiceAllocations, type runtimeServices, type environmentLeases } from "@paperclipai/db";
import { runtimeServiceDataExpirationSchema, type RuntimeServiceDataExpiration } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { readRuntimeServiceCompanyPolicy } from "./company-policy.js";

type Reader = Pick<Db, "select">;
type Policy = Awaited<ReturnType<typeof readRuntimeServiceCompanyPolicy>>;
export interface RetentionExpiryDependencies {
  allocations: Array<typeof runtimeServiceAllocations.$inferSelect>;
  services: Array<typeof runtimeServices.$inferSelect>;
  leases: Array<typeof environmentLeases.$inferSelect>;
  tasks?: Array<{ id: string; updatedAt: Date }>;
  workspaceIds?: string[];
  activityDates?: Date[];
  plan: { blockers: string[] };
}

/** A policy edit always gives existing data a full interval. Read again inside
 * the deletion transaction after taking the same locks as manual deletion. */
export async function readRuntimeServiceDataExpiration(reader: Reader, companyId: string, dependencies: RetentionExpiryDependencies, now: Date): Promise<RuntimeServiceDataExpiration> {
  const policy = await readRuntimeServiceCompanyPolicy(reader, companyId);
  const base = { policyRevision: policy.revision, retainedDataSeconds: policy.config.retainedDataSeconds, checkedAt: now.toISOString() };
  if (policy.config.retainedDataSeconds === null) return { ...base, state: "disabled", expiresAt: null, blockers: [] };
  const runIds = dependencies.leases.flatMap((lease) => lease.heartbeatRunId ? [lease.heartbeatRunId] : []);
  const taskIds = dependencies.tasks?.map((task) => task.id) ?? [];
  const workspaceIds = dependencies.workspaceIds ?? [];
  const predicates = [
    ...(runIds.length ? [inArray(heartbeatRuns.id, runIds)] : []),
    ...(taskIds.length ? [sql`${heartbeatRuns.contextSnapshot}->>'issueId' in (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)})`] : []),
    ...(workspaceIds.length ? [sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' in (${sql.join(workspaceIds.map((id) => sql`${id}`), sql`, `)})`] : []),
  ];
  // Include completed turns, including ones that began and ended between sweeps.
  const [history] = predicates.length ? await reader.select({ lastUse: sql<string | null>`max(greatest(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}, ${heartbeatRuns.createdAt}))` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), or(...predicates))) : [];
  const dates = [policy.updatedAt ? new Date(policy.updatedAt) : now,
    ...dependencies.allocations.map((row) => row.createdAt),
    ...dependencies.services.flatMap((row) => [row.createdAt, row.lastActivityAt, row.stoppedAt, row.updatedAt]),
    ...dependencies.leases.flatMap((row) => [row.createdAt, row.releasedAt]),
    ...(dependencies.tasks?.map((row) => row.updatedAt) ?? []), ...(dependencies.activityDates ?? []),
    ...(history?.lastUse ? [new Date(history.lastUse)] : []),
  ].filter((date): date is Date => date instanceof Date);
  const expiresAt = new Date(Math.max(...dates.map((date) => date.getTime())) + policy.config.retainedDataSeconds * 1000).toISOString();
  const blockers = [...new Set(dependencies.plan.blockers)];
  return { ...base, expiresAt, blockers, state: blockers.length ? "protected" : expiresAt <= now.toISOString() ? "expired" : "scheduled" };
}

export function assertRuntimeServiceDataExpired(expiration: RuntimeServiceDataExpiration, expectedRevision: number) {
  if (expiration.policyRevision !== expectedRevision || expiration.state !== "expired" || !expiration.expiresAt || expiration.retainedDataSeconds === null) {
    throw conflict("The retention policy or workspace activity changed. Data remains retained until its current expiration and dependency checks allow deletion.");
  }
  return { kind: "retention" as const, policyRevision: expiration.policyRevision, retainedDataSeconds: expiration.retainedDataSeconds, expiresAt: expiration.expiresAt };
}

export function runtimeServiceDataExpirationView(metadata: Record<string, unknown>, policy?: Policy): RuntimeServiceDataExpiration {
  const revision = policy?.revision ?? 0, seconds = policy?.config.retainedDataSeconds ?? null;
  if (seconds === null) return { policyRevision: revision, retainedDataSeconds: null, state: "disabled", checkedAt: null, expiresAt: null, blockers: [] };
  const saved = runtimeServiceDataExpirationSchema.safeParse(metadata.dataExpiration);
  if (saved.success && saved.data.policyRevision === revision && saved.data.retainedDataSeconds === seconds) return saved.data;
  return { policyRevision: revision, retainedDataSeconds: seconds, state: "pending", checkedAt: null, expiresAt: null, blockers: [] };
}
