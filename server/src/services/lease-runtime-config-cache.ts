/**
 * Per-lease cache of the resolved runtime config of a plugin-backed sandbox
 * lease (TECH-8174).
 *
 * Every pod exec of a Kubernetes sandbox run used to re-resolve the lease's
 * provider config: a validation parse, a plugin registry lookup and, for a
 * secret-backed kubeconfig, a full secret resolution (secret, binding and
 * version reads, provider config, decrypt, an `UPDATE company_secrets` and an
 * `INSERT` into the secret access-event table). A task run makes about 100
 * execs, so it paid that about 100 times for the same value.
 *
 * This cache resolves the config once per lease and reuses it for the lease's
 * later execs, file syncs and workspace realization. One secret access event
 * is recorded per cache fill, which is the actual secret access.
 *
 * Freshness:
 * - The entry is keyed by lease id and stores a fingerprint of every input the
 *   resolution reads (company, environment id, driver, config and `updatedAt`,
 *   provider key, and the full lease metadata). A changed input never matches
 *   the stored fingerprint, so it resolves again. A different lease or
 *   environment never shares an entry.
 * - A secret rotate, update or delete in this process bumps a per-company
 *   generation (`noteCompanySecretChanged`), which invalidates every entry of
 *   that company on its next read.
 * - Every entry expires after `LEASE_RUNTIME_CONFIG_CACHE_TTL_MS` (60 s). This
 *   bounds staleness for the changes the generation does not see: a secret
 *   changed by another server process, a rotation inside an external secret
 *   provider, or a provider vault config change.
 * - Lease release and destroy drop the entry.
 * - At most `LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES` entries are kept; the
 *   least recently used entry is evicted first.
 *
 * Concurrent first reads of one lease share one in-flight resolution (single
 * flight). A failed resolution is never cached, so the next read retries and
 * records its own access event, as before.
 *
 * The cache is scoped to the database handle, so every runtime service built
 * on the same handle shares it (the heartbeat runtime that runs execs and the
 * runtimes that release leases) and separate test databases never share it.
 */
import { createHash } from "node:crypto";

export const LEASE_RUNTIME_CONFIG_CACHE_TTL_MS = 60_000;
export const LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES = 512;

const companySecretGenerations = new Map<string, number>();

/** Called after a company secret is rotated, updated or deleted. */
export function noteCompanySecretChanged(companyId: string): void {
  companySecretGenerations.set(companyId, (companySecretGenerations.get(companyId) ?? 0) + 1);
}

function companySecretGeneration(companyId: string): number {
  return companySecretGenerations.get(companyId) ?? 0;
}

type CacheEntry = {
  fingerprint: string;
  companyId: string;
  generation: number;
  expiresAt: number;
  value: Promise<Record<string, unknown>>;
};

export type LeaseRuntimeConfigCache = {
  getOrResolve(input: {
    leaseId: string;
    companyId: string;
    fingerprintInput: unknown;
    resolve: () => Promise<Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
  invalidateLease(leaseId: string): void;
  readonly size: number;
};

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function createLeaseRuntimeConfigCache(): LeaseRuntimeConfigCache {
  const entries = new Map<string, CacheEntry>();
  return {
    async getOrResolve(input) {
      const now = Date.now();
      const fingerprint = createHash("sha256").update(stableStringify(input.fingerprintInput)).digest("hex");
      const generation = companySecretGeneration(input.companyId);
      const existing = entries.get(input.leaseId);
      if (
        existing
        && existing.fingerprint === fingerprint
        && existing.companyId === input.companyId
        && existing.generation === generation
        && existing.expiresAt > now
      ) {
        // Refresh the LRU position.
        entries.delete(input.leaseId);
        entries.set(input.leaseId, existing);
        return { ...(await existing.value) };
      }
      // The generation is read before the resolution starts, so a secret change
      // that lands while it runs leaves a stale generation on the entry and the
      // next read resolves again.
      const entry: CacheEntry = {
        fingerprint,
        companyId: input.companyId,
        generation,
        expiresAt: now + LEASE_RUNTIME_CONFIG_CACHE_TTL_MS,
        value: input.resolve(),
      };
      entries.delete(input.leaseId);
      entries.set(input.leaseId, entry);
      while (entries.size > LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      try {
        return { ...(await entry.value) };
      } catch (error) {
        if (entries.get(input.leaseId) === entry) entries.delete(input.leaseId);
        throw error;
      }
    },
    invalidateLease(leaseId) {
      entries.delete(leaseId);
    },
    get size() {
      return entries.size;
    },
  };
}

const cachesByDb = new WeakMap<object, LeaseRuntimeConfigCache>();

export function leaseRuntimeConfigCacheFor(db: object): LeaseRuntimeConfigCache {
  let cache = cachesByDb.get(db);
  if (!cache) {
    cache = createLeaseRuntimeConfigCache();
    cachesByDb.set(db, cache);
  }
  return cache;
}
