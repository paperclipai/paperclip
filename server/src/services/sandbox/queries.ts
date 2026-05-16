/**
 * Phase 4A-2 (LET-314): sandbox-flavored lease queries.
 *
 * The base `environmentService` returns the shared `EnvironmentLease` shape
 * which intentionally hides the LET-310 sandbox columns (kind, capabilities,
 * quotas, policyHash). This module reads the raw rows and re-exposes them
 * for the sandbox read-model assembly only — REST/SSE callers never see
 * the raw row, they always go through `toSandboxLeaseReadModel`.
 *
 * Filtering: a lease is considered sandbox-flavored when it has a non-null
 * `kind` column OR its `provider` matches a built-in sandbox provider key.
 */

import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases } from "@paperclipai/db";
import {
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  type EnvironmentLease,
  type EnvironmentLeaseStatus,
} from "@paperclipai/shared";

type EnvironmentLeaseRow = typeof environmentLeases.$inferSelect;

function readEnum<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === null) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readEnumNullable<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  if (value === null) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

function toLease(row: EnvironmentLeaseRow): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: readEnum(row.status, ENVIRONMENT_LEASE_STATUSES, "active"),
    leasePolicy: readEnum(row.leasePolicy, ENVIRONMENT_LEASE_POLICIES, "ephemeral"),
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: readEnumNullable(row.cleanupStatus, ENVIRONMENT_LEASE_CLEANUP_STATUSES),
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Merge LET-310 sandbox columns into the lease metadata view so the
 * read-model can find them in a single place. Existing metadata keys win
 * over column-only data so the docker provider's authoritative writes are
 * preserved.
 */
function mergeSandboxColumnsIntoMetadata(row: EnvironmentLeaseRow, lease: EnvironmentLease): EnvironmentLease {
  const metadata = lease.metadata ?? {};
  const merged: Record<string, unknown> = { ...metadata };
  if (row.kind && merged.kind === undefined) merged.kind = row.kind;
  if (row.reasonCode && merged.reasonCode === undefined) merged.reasonCode = row.reasonCode;
  if (row.capabilities && merged.capabilities === undefined) merged.capabilities = row.capabilities;
  if (row.quotas && merged.quotas === undefined) merged.quotas = row.quotas;
  if (row.policyHash && merged.policyHash === undefined) merged.policyHash = row.policyHash;
  return { ...lease, metadata: merged };
}

export interface SandboxLeaseQueryFilters {
  status?: EnvironmentLeaseStatus;
  environmentId?: string;
  provider?: string;
}

export interface SandboxLeaseQueryOptions {
  /**
   * The set of provider keys to treat as sandbox-flavored when the lease
   * row has no `kind` column set (i.e. legacy fake-sandbox leases).
   */
  knownProviderKeys: readonly string[];
  /** Cap the number of rows returned; 200 by default. */
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) return DEFAULT_LIMIT;
  const n = Math.floor(limit as number);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function listSandboxLeasesForCompany(
  db: Db,
  companyId: string,
  filters: SandboxLeaseQueryFilters,
  options: SandboxLeaseQueryOptions,
): Promise<EnvironmentLease[]> {
  const sandboxScope = or(
    isNotNull(environmentLeases.kind),
    options.knownProviderKeys.length > 0
      ? inArray(environmentLeases.provider, [...options.knownProviderKeys])
      : sql`false`,
  );
  const conditions = [eq(environmentLeases.companyId, companyId), sandboxScope];
  if (filters.status) conditions.push(eq(environmentLeases.status, filters.status));
  if (filters.environmentId) conditions.push(eq(environmentLeases.environmentId, filters.environmentId));
  if (filters.provider) conditions.push(eq(environmentLeases.provider, filters.provider));

  const limit = clampLimit(options.limit);
  const rows = await db
    .select()
    .from(environmentLeases)
    .where(and(...conditions))
    .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt))
    .limit(limit);
  return rows.map((row) => mergeSandboxColumnsIntoMetadata(row, toLease(row)));
}

export async function getSandboxLeaseForCompany(
  db: Db,
  companyId: string,
  leaseId: string,
): Promise<EnvironmentLease | null> {
  const row = await db
    .select()
    .from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.id, leaseId)))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  return mergeSandboxColumnsIntoMetadata(row, toLease(row));
}
