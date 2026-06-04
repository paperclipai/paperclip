import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { accountPoolState, companySecrets } from "@paperclipai/db";
import { POOL_ACCOUNT_TYPE } from "@paperclipai/shared";
import type { PoolAccount, PoolState, QuotaWindow, RotationReason } from "@paperclipai/shared";
import { readClaudeCredentialFile, writeClaudeCredentialFile } from "@paperclipai/adapter-claude-local/server";
import { secretService } from "./secrets.js";
import { refreshToken as oauthRefreshToken } from "./claude-oauth.js";

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

/**
 * Sentinel id for the implicit "Default — this machine" account card. It is NOT
 * a company_secrets row: it represents the local login agents fall back to when
 * `account_pool_state.activeAccountId` is null. When this candidate "wins" the
 * rotation, the effective activeAccountId written to the DB is null.
 */
export const DEFAULT_ACCOUNT_ID = "__default__";

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

/** Full pool-account rows (with providerMetadata) — for reading poolHealth snapshots. */
export async function listPoolAccountRows(db: Db, companyId: string): Promise<CompanySecretRow[]> {
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt)));
  return rows.filter(isPoolAccount);
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
  /** account email when known (used by the default-account snapshot) */
  email?: string | null;
  /** subscription tier label when known */
  subscriptionType?: string | null;
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
  /** identity (default-account probe): preserved on error like the metrics */
  email?: string | null;
  subscriptionType?: string | null;
}

function defaultSnapshot(): PoolAccountHealthSnapshot {
  return { usedPercent: null, resetsAt: null, capped: false, windows: [], checkedAt: "", error: null, erroredAt: null, email: null, subscriptionType: null };
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
    email: typeof h.email === "string" ? h.email : null,
    subscriptionType: typeof h.subscriptionType === "string" ? h.subscriptionType : null,
  };
}

/**
 * Persist a probe result for the company's DEFAULT (local/machine) account into
 * `account_pool_state.defaultHealth`. Same preserve-last-good-on-error logic as
 * savePoolAccountHealth, but the default has no company_secrets row so its
 * snapshot lives on the pool-state row. Stored wrapped as `{ poolHealth }` so it
 * can be parsed by the shared readPoolAccountHealth(). Ensures the state row
 * exists first (so a company with no pooled accounts still shows default health).
 */
export async function saveDefaultAccountHealth(
  db: Db,
  companyId: string,
  probe: PoolAccountProbe,
): Promise<void> {
  const existing = await db
    .select({ defaultHealth: accountPoolState.defaultHealth })
    .from(accountPoolState)
    .where(eq(accountPoolState.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  const prev = readPoolAccountHealth(existing?.defaultHealth) ?? defaultSnapshot();

  // Identity (email/tier) is preserved across probes — keep the last-known value
  // when the current probe didn't resolve it.
  const email = probe.email ?? prev.email ?? null;
  const subscriptionType = probe.subscriptionType ?? prev.subscriptionType ?? null;
  const next: PoolAccountHealthSnapshot = probe.error
    ? {
        usedPercent: prev.usedPercent,
        resetsAt: prev.resetsAt,
        capped: prev.capped,
        windows: prev.windows,
        checkedAt: prev.checkedAt,
        error: probe.error,
        erroredAt: probe.at,
        email,
        subscriptionType,
      }
    : {
        usedPercent: probe.usedPercent,
        resetsAt: probe.resetsAt,
        capped: probe.capped,
        windows: probe.windows,
        checkedAt: probe.at,
        error: null,
        erroredAt: null,
        email,
        subscriptionType,
      };

  const now = new Date();
  await db
    .insert(accountPoolState)
    .values({ companyId, reason: "initial", defaultHealth: { poolHealth: next }, updatedAt: now })
    .onConflictDoUpdate({
      target: accountPoolState.companyId,
      set: { defaultHealth: { poolHealth: next }, updatedAt: now },
    });
}

/** Read the company's DEFAULT account health snapshot, or null when never probed. */
export async function getDefaultAccountHealth(
  db: Db,
  companyId: string,
): Promise<PoolAccountHealthSnapshot | null> {
  const row = await db
    .select({ defaultHealth: accountPoolState.defaultHealth })
    .from(accountPoolState)
    .where(eq(accountPoolState.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  return readPoolAccountHealth(row?.defaultHealth);
}

/** True when a snapshot says the account is capped and its reset time is still in the future. */
export function isSnapshotCappedNow(snapshot: PoolAccountHealthSnapshot | null, now = new Date()): boolean {
  if (!snapshot?.capped) return false;
  if (!snapshot.resetsAt) return true; // capped with unknown reset → treat as capped
  const reset = new Date(snapshot.resetsAt);
  return Number.isNaN(reset.getTime()) ? true : reset.getTime() > now.getTime();
}

/**
 * Mark a POOL account capped until `untilIso` (reactive cap on a quota hit during
 * a run). Preserves last-good metrics; only flips capped + resetsAt so the
 * account is skipped for selection until it resets.
 */
export async function markPoolAccountCapped(db: Db, accountId: string, untilIso: string | null): Promise<void> {
  const row = await db
    .select({ providerMetadata: companySecrets.providerMetadata })
    .from(companySecrets)
    .where(eq(companySecrets.id, accountId))
    .then((rows) => rows[0] ?? null);
  const prev = readPoolAccountHealth(row?.providerMetadata) ?? defaultSnapshot();
  const next: PoolAccountHealthSnapshot = { ...prev, capped: true, resetsAt: untilIso };
  const patch = JSON.stringify({ poolHealth: next });
  await db
    .update(companySecrets)
    .set({
      providerMetadata: sql`COALESCE(${companySecrets.providerMetadata}, '{}'::jsonb) || ${patch}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(companySecrets.id, accountId));
}

/** Mark the DEFAULT (local) account capped until `untilIso`. */
export async function markDefaultAccountCapped(db: Db, companyId: string, untilIso: string | null): Promise<void> {
  const existing = await db
    .select({ defaultHealth: accountPoolState.defaultHealth })
    .from(accountPoolState)
    .where(eq(accountPoolState.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  const prev = readPoolAccountHealth(existing?.defaultHealth) ?? defaultSnapshot();
  const next: PoolAccountHealthSnapshot = { ...prev, capped: true, resetsAt: untilIso };
  const now = new Date();
  await db
    .insert(accountPoolState)
    .values({ companyId, reason: "initial", defaultHealth: { poolHealth: next }, updatedAt: now })
    .onConflictDoUpdate({
      target: accountPoolState.companyId,
      set: { defaultHealth: { poolHealth: next }, updatedAt: now },
    });
}

/** refresh when the access token has < this long left (or is already expired) */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface FreshPoolToken {
  /** a non-expired access token, or null when unavailable */
  accessToken: string | null;
  /** the current (possibly just-refreshed) full credentials blob */
  credentialsJson: string;
  refreshed: boolean;
  error: string | null;
}

/**
 * Return a non-expired access token for a pooled OAuth account, refreshing via
 * the stored refresh_token when the access token is near/over expiry (Claude
 * OAuth tokens last ~8h). On refresh the secret value is rotated (new version)
 * so the fresh token persists. Best-effort: any failure falls back to the
 * existing token/blob so a transient refresh error never breaks a run.
 */
export async function ensureFreshPoolToken(
  db: Db,
  companyId: string,
  accountId: string,
): Promise<FreshPoolToken> {
  const svc = secretService(db);
  const blob = await svc.resolveSecretValue(companyId, accountId, "latest");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blob) as Record<string, unknown>;
  } catch {
    return { accessToken: null, credentialsJson: blob, refreshed: false, error: "invalid credentials json" };
  }
  const oauth = (parsed.claudeAiOauth ?? {}) as Record<string, unknown>;
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
  const refreshTok = typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;

  const needsRefresh = !!refreshTok && expiresAt != null && expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;
  if (!needsRefresh) {
    return { accessToken, credentialsJson: blob, refreshed: false, error: null };
  }

  try {
    const fresh = await oauthRefreshToken(refreshTok);
    const nextBlob = JSON.stringify({
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        accessToken: fresh.accessToken,
        // Anthropic may rotate the refresh token — persist the new one.
        refreshToken: fresh.refreshToken ?? refreshTok,
        expiresAt: fresh.expiresAt,
        scopes: fresh.scopes.length > 0 ? fresh.scopes : oauth.scopes,
      },
    });
    await svc.rotate(accountId, { value: nextBlob });
    return { accessToken: fresh.accessToken, credentialsJson: nextBlob, refreshed: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { accessToken, credentialsJson: blob, refreshed: false, error: message };
  }
}

/** Result of a default (local) account refresh-on-use attempt. */
export interface FreshLocalToken {
  /** non-expired access token to probe with, or null when there's no usable login */
  accessToken: string | null;
  /** true when a refresh actually happened (token rotated + written back) */
  refreshed: boolean;
  /** non-null when a refresh was attempted but failed (caller can surface/log it) */
  error: string | null;
}

/**
 * Refresh-on-use for the machine's DEFAULT (local) account — the on-disk twin of
 * {@link ensureFreshPoolToken}. The default account is the live `~/.claude`
 * login (the Claude CLI owns the file). When no agent has run for a while the
 * file's access token goes stale (~8h), so a read-only quota probe gets a 401.
 *
 * Option 2 (mirror the CLI): read the file blob, and if the access token is at/
 * near expiry, refresh via the stored refresh_token and write the fresh blob
 * straight back to the file — keeping the probe AND the running CLI in sync,
 * and persisting the rotated refresh token so the next refresh still works.
 *
 * FILE login only. On macOS the CLI keeps creds in the Keychain (no file) — this
 * returns `accessToken: null` so the caller falls back to readClaudeToken(),
 * which the live CLI keeps fresh. Best-effort throughout: any read/refresh/write
 * failure degrades to the existing (possibly stale) token rather than throwing,
 * so a quota probe never breaks the run path.
 */
export async function ensureFreshLocalToken(): Promise<FreshLocalToken> {
  let file: Awaited<ReturnType<typeof readClaudeCredentialFile>>;
  try {
    file = await readClaudeCredentialFile();
  } catch (error) {
    return { accessToken: null, refreshed: false, error: error instanceof Error ? error.message : String(error) };
  }
  // No file-based login (e.g. macOS Keychain-only) — caller falls back.
  if (!file) return { accessToken: null, refreshed: false, error: null };

  const { accessToken, refreshToken: refreshTok, expiresAt } = file;
  const needsRefresh = !!refreshTok && expiresAt != null && expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;
  if (!needsRefresh) {
    return { accessToken, refreshed: false, error: null };
  }

  try {
    const fresh = await oauthRefreshToken(refreshTok!);
    const nextBlob = JSON.stringify({
      ...file.raw,
      claudeAiOauth: {
        ...file.oauth,
        accessToken: fresh.accessToken,
        // Anthropic may rotate the refresh token — persist the new one.
        refreshToken: fresh.refreshToken ?? refreshTok,
        expiresAt: fresh.expiresAt,
        scopes: fresh.scopes.length > 0 ? fresh.scopes : file.oauth.scopes,
      },
    });
    await writeClaudeCredentialFile(file.filePath, nextBlob);
    return { accessToken: fresh.accessToken, refreshed: true, error: null };
  } catch (error) {
    // Refresh/write failed — fall back to the (possibly expired) token; an honest
    // 401 on the probe beats crashing the default-account health path.
    return { accessToken, refreshed: false, error: error instanceof Error ? error.message : String(error) };
  }
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
