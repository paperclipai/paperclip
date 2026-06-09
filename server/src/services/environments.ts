import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
  type CreateEnvironment,
  type Environment,
  type EnvironmentLease,
  type EnvironmentLeaseCleanupStatus,
  type EnvironmentLeasePolicy,
  type EnvironmentLeaseStatus,
  type UpdateEnvironment,
} from "@paperclipai/shared";

type EnvironmentRow = typeof environments.$inferSelect;
type EnvironmentLeaseRow = typeof environmentLeases.$inferSelect;
const DEFAULT_LOCAL_ENVIRONMENT_NAME = "Local";
const DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION =
  "Default execution environment for Paperclip runs on this machine.";

function cloneRecord(value: unknown, fallback: Record<string, unknown> | null = null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return { ...(value as Record<string, unknown>) };
}

function readEnum<T extends string>(value: string | null, allowed: readonly T[], fieldName: string): T | null {
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${fieldName} value: ${value}`);
}

function toEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description ?? null,
    driver: readEnum(row.driver, ENVIRONMENT_DRIVERS, "environment driver") ?? "local",
    status: readEnum(row.status, ENVIRONMENT_STATUSES, "environment status") ?? "active",
    config: cloneRecord(row.config, {}) ?? {},
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEnvironmentLease(row: EnvironmentLeaseRow): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: readEnum(row.status, ENVIRONMENT_LEASE_STATUSES, "environment lease status") ?? "active",
    leasePolicy: readEnum(row.leasePolicy, ENVIRONMENT_LEASE_POLICIES, "environment lease policy") ?? "ephemeral",
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: readEnum(
      row.cleanupStatus,
      ENVIRONMENT_LEASE_CLEANUP_STATUSES,
      "environment lease cleanup status",
    ),
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Heartbeat run statuses that still represent a live, executing run. A lease
 * whose holding run is NOT in one of these states is considered abandoned and
 * may be adopted by a new acquirer (see {@link leaseHolderIsStale}). Kept in
 * sync with the terminal-status helpers in services/heartbeat.ts.
 */
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

/**
 * Lease policies that participate in the single-flight workspace guardrail.
 * Only ephemeral, single-use leases bound to a shared execution workspace
 * (local/SSH checkouts) are guarded; sandbox `reuse_by_environment` leases and
 * workspace-less leases keep their prior multi-acquire behavior.
 */
const SINGLE_FLIGHT_LEASE_POLICY: EnvironmentLeasePolicy = "ephemeral";

/**
 * Thrown when a heartbeat run tries to acquire an ephemeral lease for a shared
 * execution workspace that another live, non-terminal run already holds. Code
 * paths that set up a run should treat this as "another run owns the
 * workspace — defer", not as a hard infrastructure failure.
 */
export class EnvironmentLeaseConflictError extends Error {
  readonly code = "environment_lease_conflict";
  readonly environmentId: string;
  readonly executionWorkspaceId: string;
  readonly conflictingLeaseId: string;
  readonly conflictingRunId: string | null;
  readonly conflictingIssueId: string | null;

  constructor(details: {
    environmentId: string;
    executionWorkspaceId: string;
    conflictingLeaseId: string;
    conflictingRunId: string | null;
    conflictingIssueId: string | null;
  }) {
    super(
      `Execution workspace ${details.executionWorkspaceId} is already leased by an active run` +
        (details.conflictingRunId ? ` (run ${details.conflictingRunId})` : "") +
        `; refusing to acquire a concurrent single-flight lease.`,
    );
    this.name = "EnvironmentLeaseConflictError";
    this.environmentId = details.environmentId;
    this.executionWorkspaceId = details.executionWorkspaceId;
    this.conflictingLeaseId = details.conflictingLeaseId;
    this.conflictingRunId = details.conflictingRunId;
    this.conflictingIssueId = details.conflictingIssueId;
  }
}

/**
 * Postgres unique_violation (SQLSTATE 23505), surfaced by the `postgres` driver.
 * Drizzle wraps the driver error in a DrizzleQueryError, so walk the cause chain.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A workspace lease is adoptable (stale) when it is expired, orphaned of a
 * heartbeat run, or its holding run has reached a terminal state. Live holders
 * are NOT stale and must block a competing acquirer.
 */
async function leaseHolderIsStale(db: Db, lease: EnvironmentLeaseRow, now: Date): Promise<boolean> {
  if (lease.expiresAt && lease.expiresAt.getTime() <= now.getTime()) return true;
  if (!lease.heartbeatRunId) return true;
  const run = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, lease.heartbeatRunId))
    .then((rows) => rows[0] ?? null);
  if (!run) return true;
  return !(LIVE_HEARTBEAT_RUN_STATUSES as readonly string[]).includes(run.status);
}

/** Most-recent ACTIVE lease holding a given (environment, execution workspace), if any. */
async function findActiveWorkspaceLease(
  db: Db,
  environmentId: string,
  executionWorkspaceId: string,
): Promise<EnvironmentLeaseRow | null> {
  return db
    .select()
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.environmentId, environmentId),
        eq(environmentLeases.executionWorkspaceId, executionWorkspaceId),
        eq(environmentLeases.status, "active"),
      ),
    )
    .orderBy(desc(environmentLeases.acquiredAt), desc(environmentLeases.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function environmentService(db: Db) {
  return {
    list: async (
      companyId: string,
      filters: {
        status?: string;
        driver?: string;
      } = {},
    ): Promise<Environment[]> => {
      const conditions = [eq(environments.companyId, companyId)];
      if (filters.status) conditions.push(eq(environments.status, filters.status));
      if (filters.driver) conditions.push(eq(environments.driver, filters.driver));
      const rows = await db
        .select()
        .from(environments)
        .where(and(...conditions))
        .orderBy(desc(environments.updatedAt), desc(environments.createdAt));
      return rows.map(toEnvironment);
    },

    getById: async (id: string): Promise<Environment | null> => {
      const row = await db.select().from(environments).where(eq(environments.id, id)).then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    getLeaseById: async (id: string): Promise<EnvironmentLease | null> => {
      const row = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    ensureLocalEnvironment: async (companyId: string): Promise<Environment> => {
      const now = new Date();
      const row = await db
        .insert(environments)
        .values({
          companyId,
          name: DEFAULT_LOCAL_ENVIRONMENT_NAME,
          description: DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION,
          driver: "local",
          status: "active",
          config: {},
          metadata: {
            managedByPaperclip: true,
            defaultForCompany: true,
          },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [environments.companyId, environments.driver],
          where: sql`${environments.driver} = 'local'`,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return toEnvironment(row);

      const existing = await db
        .select()
        .from(environments)
        .where(and(eq(environments.companyId, companyId), eq(environments.driver, "local")))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error("Failed to ensure local environment");
      }
      return toEnvironment(existing);
    },

    create: async (companyId: string, input: CreateEnvironment): Promise<Environment> => {
      const now = new Date();
      const row = await db
        .insert(environments)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          driver: input.driver,
          status: input.status ?? "active",
          config: input.config ?? {},
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) {
        throw new Error("Failed to create environment");
      }
      return toEnvironment(row);
    },

    update: async (id: string, patch: UpdateEnvironment): Promise<Environment | null> => {
      const values: Partial<typeof environments.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.description !== undefined) values.description = patch.description ?? null;
      if (patch.driver !== undefined) values.driver = patch.driver;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.config !== undefined) values.config = patch.config;
      if (patch.metadata !== undefined) values.metadata = patch.metadata ?? null;

      const row = await db
        .update(environments)
        .set(values)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    remove: async (id: string): Promise<Environment | null> => {
      const row = await db
        .delete(environments)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    listLeases: async (
      environmentId: string,
      filters: {
        status?: string;
      } = {},
    ): Promise<EnvironmentLease[]> => {
      const conditions = [eq(environmentLeases.environmentId, environmentId)];
      if (filters.status) conditions.push(eq(environmentLeases.status, filters.status));
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(and(...conditions))
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));
      return rows.map(toEnvironmentLease);
    },

    acquireLease: async (input: {
      companyId: string;
      environmentId: string;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
      heartbeatRunId?: string | null;
      leasePolicy?: EnvironmentLeasePolicy;
      provider?: string | null;
      providerLeaseId?: string | null;
      expiresAt?: Date | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<EnvironmentLease> => {
      const now = new Date();
      const executionWorkspaceId = input.executionWorkspaceId ?? null;
      const heartbeatRunId = input.heartbeatRunId ?? null;
      const leasePolicy = input.leasePolicy ?? "ephemeral";

      const insertLease = async (): Promise<EnvironmentLease> => {
        const row = await db
          .insert(environmentLeases)
          .values({
            companyId: input.companyId,
            environmentId: input.environmentId,
            executionWorkspaceId,
            issueId: input.issueId ?? null,
            heartbeatRunId,
            status: "active",
            leasePolicy,
            provider: input.provider ?? null,
            providerLeaseId: input.providerLeaseId ?? null,
            acquiredAt: now,
            lastUsedAt: now,
            expiresAt: input.expiresAt ?? null,
            releasedAt: null,
            failureReason: null,
            cleanupStatus: null,
            metadata: input.metadata ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) {
          throw new Error("Failed to acquire environment lease");
        }
        return toEnvironmentLease(row);
      };

      // Single-flight guard only applies to ephemeral leases bound to a concrete
      // shared execution workspace (local/SSH checkouts). Workspace-less leases
      // and sandbox reuse leases keep their prior multi-acquire behavior.
      const singleFlight = executionWorkspaceId !== null && leasePolicy === SINGLE_FLIGHT_LEASE_POLICY;
      if (!singleFlight) {
        return insertLease();
      }

      const conflictFrom = (lease: EnvironmentLeaseRow): EnvironmentLeaseConflictError =>
        new EnvironmentLeaseConflictError({
          environmentId: input.environmentId,
          executionWorkspaceId,
          conflictingLeaseId: lease.id,
          conflictingRunId: lease.heartbeatRunId ?? null,
          conflictingIssueId: lease.issueId ?? null,
        });

      const existing = await findActiveWorkspaceLease(db, input.environmentId, executionWorkspaceId);
      if (existing) {
        // Re-entrant: the same run already owns this workspace lease. Preserve
        // existing same-issue/run behavior by reusing it rather than failing.
        if (heartbeatRunId !== null && existing.heartbeatRunId === heartbeatRunId) {
          const touched = await db
            .update(environmentLeases)
            .set({ lastUsedAt: now, updatedAt: now })
            .where(eq(environmentLeases.id, existing.id))
            .returning()
            .then((rows) => rows[0] ?? null);
          return toEnvironmentLease(touched ?? existing);
        }
        // A different run holds the workspace. Adopt it only if its holder is
        // stale/terminal so abandoned leases can't deadlock the workspace.
        if (!(await leaseHolderIsStale(db, existing, now))) {
          throw conflictFrom(existing);
        }
        await db
          .update(environmentLeases)
          .set({
            status: "expired",
            releasedAt: now,
            lastUsedAt: now,
            updatedAt: now,
            failureReason: existing.failureReason ?? "superseded: stale single-flight workspace lease",
          })
          .where(and(eq(environmentLeases.id, existing.id), eq(environmentLeases.status, "active")));
      }

      try {
        return await insertLease();
      } catch (err) {
        // Lost a race to a concurrent acquirer; the partial unique index rejects
        // the second active lease. Surface it as a clean conflict, not a 500.
        if (isUniqueViolation(err)) {
          const winner = await findActiveWorkspaceLease(db, input.environmentId, executionWorkspaceId);
          if (winner && winner.heartbeatRunId !== heartbeatRunId) {
            throw conflictFrom(winner);
          }
          throw new EnvironmentLeaseConflictError({
            environmentId: input.environmentId,
            executionWorkspaceId,
            conflictingLeaseId: winner?.id ?? "unknown",
            conflictingRunId: winner?.heartbeatRunId ?? null,
            conflictingIssueId: winner?.issueId ?? null,
          });
        }
        throw err;
      }
    },

    releaseLease: async (
      id: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained"> = "released",
      options?: {
        failureReason?: string;
        cleanupStatus?: EnvironmentLeaseCleanupStatus;
      },
    ) => {
      const now = new Date();
      const row = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: status === "retained" ? null : now,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    updateLeaseMetadata: async (
      id: string,
      metadata: Record<string, unknown> | null,
    ): Promise<EnvironmentLease | null> => {
      const row = await db
        .update(environmentLeases)
        .set({
          metadata,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    releaseLeasesForRun: async (
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentLease[]> => {
      const now = new Date();
      const rows = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            eq(environmentLeases.status, "active"),
          ),
        )
        .returning();
      return rows.map(toEnvironmentLease);
    },
  };
}
