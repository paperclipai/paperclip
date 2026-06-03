import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { accountPoolState, companySecrets } from "@paperclipai/db";
import { POOL_ACCOUNT_TYPE } from "@paperclipai/shared";
import type { PoolAccount, PoolState, QuotaWindow, RotationReason } from "@paperclipai/shared";

/**
 * Data-access helpers for the Account Pool & Rotation feature.
 *
 * Pool membership lives on `company_secrets` rows whose
 * `providerMetadata.poolType === POOL_ACCOUNT_TYPE` ("claude_account").
 * The current load-balancer assignment lives in `account_pool_state`
 * (one row per company). These helpers are the single read/write surface
 * shared by the Balancer Brain cron and the (future) API layer.
 *
 * Spec: docs/superpowers/specs/2026-06-02-account-pool-rotation-spec.md
 */

type CompanySecretRow = typeof companySecrets.$inferSelect;
type AccountPoolStateRow = typeof accountPoolState.$inferSelect;

/** narrowing guard: is this secret row a pool account? */
function isPoolAccount(row: CompanySecretRow): boolean {
  const meta = row.providerMetadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as Record<string, unknown>).poolType === POOL_ACCOUNT_TYPE;
}

/** project a company_secrets row to the shared PoolAccount contract */
function toPoolAccount(row: CompanySecretRow): PoolAccount {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    status: row.status,
  };
}

function toPoolState(row: AccountPoolStateRow): PoolState {
  return {
    companyId: row.companyId,
    activeAccountId: row.activeAccountId,
    prevAccountId: row.prevAccountId,
    reason: row.reason as RotationReason,
    assignedAt: row.assignedAt.toISOString(),
    rotationStopped: row.rotationStopped,
    stopReason: row.stopReason,
  };
}

/**
 * All pooled accounts for a company. Filters company_secrets to the
 * `poolType` marker and excludes soft-deleted rows. JSON filtering of the
 * marker is done in JS (after a narrow company query) to keep the helper
 * portable across the providerMetadata shape rather than relying on a
 * jsonb path expression here.
 */
export async function listPoolAccounts(db: Db, companyId: string): Promise<PoolAccount[]> {
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt)));
  return rows.filter(isPoolAccount).map(toPoolAccount);
}

/** Resolve a single pool account row (with full secret metadata) by id. */
export async function getPoolAccountRow(
  db: Db,
  companyId: string,
  accountId: string,
): Promise<CompanySecretRow | null> {
  const row = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.id, accountId), eq(companySecrets.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row || !isPoolAccount(row) || row.deletedAt) return null;
  return row;
}

/** Current load-balancer state for a company, or null when never assigned. */
export async function getPoolState(db: Db, companyId: string): Promise<PoolState | null> {
  const row = await db
    .select()
    .from(accountPoolState)
    .where(eq(accountPoolState.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  return row ? toPoolState(row) : null;
}

/**
 * Upsert the active account for a company. Idempotent on `companyId`
 * (enforced by the unique index `account_pool_state_company_uq`).
 *
 * When the active account changes the caller should pass `prevAccountId`
 * (the account being rotated away from) and `reason: "rotation"` so the
 * audit trail + "last rotation" display are accurate.
 */
export async function setActiveAccount(
  db: Db,
  input: {
    companyId: string;
    activeAccountId: string | null;
    prevAccountId?: string | null;
    reason: RotationReason;
    assignedAt?: Date;
  },
): Promise<PoolState> {
  const now = input.assignedAt ?? new Date();
  const [row] = await db
    .insert(accountPoolState)
    .values({
      companyId: input.companyId,
      activeAccountId: input.activeAccountId,
      prevAccountId: input.prevAccountId ?? null,
      reason: input.reason,
      assignedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: accountPoolState.companyId,
      set: {
        activeAccountId: input.activeAccountId,
        prevAccountId: input.prevAccountId ?? null,
        reason: input.reason,
        assignedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return toPoolState(row);
}

/**
 * Last-known health probe for a pool account, persisted by the Balancer Brain so
 * the API can show health for EVERY account (not just the active one) WITHOUT
 * re-probing the Anthropic usage API on each UI poll (that polling is what got us
 * rate-limited — 429). The metric fields (usedPercent/resetsAt/capped/windows)
 * always hold the last SUCCESSFUL probe; `error`/`erroredAt` record the most
 * recent failure without clobbering the known-good metrics.
 */
export interface PoolAccountHealthSnapshot {
  usedPercent: number | null;
  resetsAt: string | null;
  capped: boolean;
  /** per-window detail (session / week / …) from the last successful probe */
  windows: QuotaWindow[];
  /** iso timestamp of the last SUCCESSFUL probe */
  checkedAt: string;
  /** message from the most recent failed probe (e.g. "anthropic usage api returned 429"), else null */
  error: string | null;
  /** iso timestamp of the most recent failed probe */
  erroredAt: string | null;
}

/** the raw result of probing one account, as produced by the Balancer */
export interface PoolAccountProbe {
  usedPercent: number | null;
  resetsAt: string | null;
  capped: boolean;
  windows: QuotaWindow[];
  /** set when the probe failed; when present the last-good metrics are preserved */
  error: string | null;
  /** iso timestamp of this probe attempt */
  at: string;
}

function defaultSnapshot(): PoolAccountHealthSnapshot {
  return { usedPercent: null, resetsAt: null, capped: false, windows: [], checkedAt: "", error: null, erroredAt: null };
}

/**
 * Persist a probe result into `providerMetadata.poolHealth`.
 *
 * On SUCCESS: replace the metrics and clear any prior error.
 * On FAILURE (e.g. 429): keep the last-good metrics intact and only record the
 * error + timestamp, so a transient rate-limit never wipes known-good health.
 *
 * Uses a jsonb merge (`||`) so the `poolType` marker is preserved and NO new
 * secret version is created (this is metadata, not a credential rotation).
 */
export async function savePoolAccountHealth(
  db: Db,
  accountId: string,
  probe: PoolAccountProbe,
): Promise<void> {
  const row = await db
    .select({ providerMetadata: companySecrets.providerMetadata })
    .from(companySecrets)
    .where(eq(companySecrets.id, accountId))
    .then((rows) => rows[0] ?? null);
  const prev = readPoolAccountHealth(row?.providerMetadata) ?? defaultSnapshot();

  const next: PoolAccountHealthSnapshot = probe.error
    ? {
        // preserve last-good metrics; only stamp the failure
        usedPercent: prev.usedPercent,
        resetsAt: prev.resetsAt,
        capped: prev.capped,
        windows: prev.windows,
        checkedAt: prev.checkedAt,
        error: probe.error,
        erroredAt: probe.at,
      }
    : {
        usedPercent: probe.usedPercent,
        resetsAt: probe.resetsAt,
        capped: probe.capped,
        windows: probe.windows,
        checkedAt: probe.at,
        error: null,
        erroredAt: null,
      };

  const patch = JSON.stringify({ poolHealth: next });
  await db
    .update(companySecrets)
    .set({
      providerMetadata: sql`COALESCE(${companySecrets.providerMetadata}, '{}'::jsonb) || ${patch}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(companySecrets.id, accountId));
}

/** Read the last-known health snapshot from a pool account's providerMetadata. */
export function readPoolAccountHealth(providerMetadata: unknown): PoolAccountHealthSnapshot | null {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const raw = (providerMetadata as Record<string, unknown>).poolHealth;
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  return {
    usedPercent: typeof h.usedPercent === "number" ? h.usedPercent : null,
    resetsAt: typeof h.resetsAt === "string" ? h.resetsAt : null,
    capped: h.capped === true,
    windows: Array.isArray(h.windows) ? (h.windows as QuotaWindow[]) : [],
    checkedAt: typeof h.checkedAt === "string" ? h.checkedAt : "",
    error: typeof h.error === "string" ? h.error : null,
    erroredAt: typeof h.erroredAt === "string" ? h.erroredAt : null,
  };
}

/** Read the global STOP switch (D3) for a company. Defaults to not-stopped. */
export async function getStopSwitch(
  db: Db,
  companyId: string,
): Promise<{ stopped: boolean; reason: string | null }> {
  const state = await getPoolState(db, companyId);
  return { stopped: state?.rotationStopped ?? false, reason: state?.stopReason ?? null };
}

/**
 * Engage / release the global STOP switch. Creates the pool-state row if it
 * does not exist yet so the operator can pre-arm the switch before any
 * rotation has happened.
 */
export async function setStopSwitch(
  db: Db,
  input: { companyId: string; stopped: boolean; reason?: string | null },
): Promise<PoolState> {
  const now = new Date();
  const [row] = await db
    .insert(accountPoolState)
    .values({
      companyId: input.companyId,
      rotationStopped: input.stopped,
      stopReason: input.stopped ? input.reason ?? null : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: accountPoolState.companyId,
      set: {
        rotationStopped: input.stopped,
        stopReason: input.stopped ? input.reason ?? null : null,
        updatedAt: now,
      },
    })
    .returning();
  return toPoolState(row);
}
