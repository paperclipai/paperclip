import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { fetchCodexModelCatalog, readCodexCommandVersion } from "@paperclipai/adapter-codex-local/server";
import { logger } from "../middleware/logger.js";
import { aiConnectionService } from "./ai-connections.js";

// The Codex CLI refreshes its own catalog on a similar cadence. A new model
// shows up in the picker within this window; Refresh skips the wait.
const CATALOG_TTL_MS = 10 * 60_000;
const VERSION_TTL_MS = 10 * 60_000;
// Refresh starts a new lookup only when the last one has finished and began at
// least this long ago; a lookup in flight is always shared. Repeated Refresh calls
// thus cannot stack up Codex processes or catalog requests.
const REFRESH_INTERVAL_MS = 60_000;
// One account's lookup, token refresh included, is cancelled after this even
// when nobody waits for the answer any more.
const ACCOUNT_LOOKUP_TIMEOUT_MS = 20_000;
const ACCOUNT_LOOKUP_CONCURRENCY = 4;
// The longest the model picker waits for the live catalog before it shows the
// static list. The catalog request itself times out after 5 seconds.
const LOOKUP_BUDGET_MS = 8_000;
// Accounts and CLI versions change over a server's life. Expired entries are
// dropped on each lookup, and the oldest go first past this bound.
const MAX_CACHED_CATALOGS = 256;

type CacheEntry<T> = { started: number; expires: number; settled: boolean; value: Promise<T> };

const catalogs = new Map<string, CacheEntry<AdapterModel[]>>();
let installedVersion: CacheEntry<string | null> | null = null;

function cacheEntry<T>(value: Promise<T>, ttlMs: number): CacheEntry<T> {
  const now = Date.now();
  const entry: CacheEntry<T> = { started: now, expires: now + ttlMs, settled: false, value };
  const settle = () => { entry.settled = true; };
  void value.then(settle, settle);
  return entry;
}

function reusable(entry: CacheEntry<unknown> | null | undefined, refresh: boolean): boolean {
  if (!entry) return false;
  if (!entry.settled) return true;
  const now = Date.now();
  if (entry.expires <= now) return false;
  return !refresh || entry.started + REFRESH_INTERVAL_MS > now;
}

/** The Codex CLI on the Paperclip host, which `codex_local` agents run. */
function installedCodexVersion(refresh: boolean): Promise<string | null> {
  if (!reusable(installedVersion, refresh)) {
    installedVersion = cacheEntry(readCodexCommandVersion({
      runId: "codex-model-catalog",
      command: "codex",
      target: null,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    }), VERSION_TTL_MS);
  }
  return installedVersion!.value;
}

function readSubscriptionToken(value: string): { accessToken: string; accountId: string | null } | null {
  let auth: { tokens?: { access_token?: unknown; account_id?: unknown }; accessToken?: unknown; accountId?: unknown };
  try { auth = JSON.parse(value); } catch { return null; }
  const accessToken = auth.tokens?.access_token ?? auth.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const accountId = auth.tokens?.account_id ?? auth.accountId;
  return { accessToken, accountId: typeof accountId === "string" && accountId ? accountId : null };
}

/**
 * Codex models offered by the ChatGPT subscriptions this user can use in the
 * company, as the installed Codex CLI would list them. The static adapter list
 * only changes with a Paperclip release, so a model OpenAI ships in between is
 * missing from the picker even though the CLI can already run it.
 *
 * Returns an empty list when no subscription is connected, the Codex CLI
 * version is unknown, or the backend does not answer; the caller then keeps
 * the static list. Never falls back to the host's own Codex login.
 */
export async function listCodexSubscriptionModels(
  db: Db,
  companyId: string,
  userId: string,
  options: { refresh?: boolean; budgetMs?: number; accountTimeoutMs?: number } = {},
): Promise<AdapterModel[]> {
  // The picker must not wait on the live catalog or fail because of it. A
  // slow lookup keeps running, within its own deadline, and fills the cache
  // for the next request.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<AdapterModel[]>((resolve) => {
    timer = setTimeout(() => resolve([]), options.budgetMs ?? LOOKUP_BUDGET_MS);
    timer.unref?.();
  });
  const lookup = lookupCodexSubscriptionModels(db, companyId, userId, options).catch((error: unknown) => {
    logger.warn({ companyId, err: error instanceof Error ? error.name : typeof error }, "Codex subscription model lookup failed");
    return [] as AdapterModel[];
  });
  try {
    return await Promise.race([lookup, budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupCodexSubscriptionModels(
  db: Db,
  companyId: string,
  userId: string,
  options: { refresh?: boolean; accountTimeoutMs?: number },
): Promise<AdapterModel[]> {
  pruneCatalogs();
  const service = aiConnectionService(db);
  const accounts = (await service.quotaAccounts(companyId, userId))
    .filter((row) => row.summary.provider === "openai" && row.summary.status === "connected");
  if (!accounts.length) return [];
  const clientVersion = await installedCodexVersion(options.refresh === true);
  if (!clientVersion) return [];

  const readAccount = (row: (typeof accounts)[number]): Promise<AdapterModel[]> => {
    const accountKey = createHash("sha256").update(JSON.stringify([
      companyId, row.connection.id, row.grant.id, row.connection.updatedAt, row.grant.updatedAt,
      row.grant.credentialSecretRefs.map((ref) => ref.secretId),
    ])).digest("hex");
    const key = `${userId}:${accountKey}:${clientVersion}`;
    const cached = catalogs.get(key);
    if (reusable(cached, options.refresh === true)) return cached!.value;
    const signal = AbortSignal.timeout(options.accountTimeoutMs ?? ACCOUNT_LOOKUP_TIMEOUT_MS);
    const models: Promise<AdapterModel[]> = (async () => {
      const value = await service.credential(row);
      const token = readSubscriptionToken(value);
      if (!token) return [];
      try {
        return await fetchCodexModelCatalog({ ...token, clientVersion, signal });
      } catch (error) {
        if (!(error instanceof Error) || !/\b401\b/.test(error.message)) throw error;
        const refreshed = readSubscriptionToken(await service.refreshQuotaCredential(row, value, signal));
        if (!refreshed) return [];
        return fetchCodexModelCatalog({ ...refreshed, clientVersion, signal });
      }
    })().catch((error: unknown) => {
      // Provider errors can echo credential material; log the family only.
      logger.warn(
        { companyId, connectionId: row.connection.id, status: error instanceof Error ? /\b(\d{3})\b/.exec(error.message)?.[1] : undefined },
        "Codex subscription model catalog unavailable",
      );
      // Drop only this request's entry; a later lookup may have replaced it.
      if (catalogs.get(key)?.value === models) catalogs.delete(key);
      return [] as AdapterModel[];
    });
    catalogs.delete(key);
    catalogs.set(key, cacheEntry(models, CATALOG_TTL_MS));
    evictOldestCatalogs();
    return models;
  };

  const perAccount: AdapterModel[][] = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_LOOKUP_CONCURRENCY, accounts.length) }, async () => {
    while (next < accounts.length) {
      const index = next++;
      perAccount[index] = await readAccount(accounts[index]);
    }
  }));

  const seen = new Set<string>();
  return perAccount.flat().filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

function pruneCatalogs() {
  const now = Date.now();
  for (const [key, entry] of catalogs) if (entry.settled && entry.expires <= now) catalogs.delete(key);
}

/** Keep the cache within its bound after every insert, oldest out first. */
function evictOldestCatalogs() {
  // Map keeps insertion order, and a stored key is re-inserted, so the first
  // keys are the least recently stored entries.
  for (const key of catalogs.keys()) {
    if (catalogs.size <= MAX_CACHED_CATALOGS) break;
    catalogs.delete(key);
  }
}

export function codexSubscriptionModelsCacheSizeForTests() {
  return catalogs.size;
}

export function resetCodexSubscriptionModelsCacheForTests() {
  catalogs.clear();
  installedVersion = null;
}
