import type { CredentialType, QuotaWindow } from "@paperclipai/shared";

export const QUOTA_PROVIDER_REFRESH_MS = 15 * 60 * 1000;
export const QUOTA_ERROR_COOLDOWN_MS = 15 * 60 * 1000;
export const QUOTA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type CredentialQuotaCacheEntry = {
  type: CredentialType;
  credentialUpdatedAtMs: number;
  source: string;
  quotaWindows: QuotaWindow[];
  sampledAt: string;
};

export type CredentialQuotaErrorCacheEntry = {
  type: CredentialType;
  credentialUpdatedAtMs: number;
  error: string;
  failedAt: string;
};

const credentialQuotaCache = new Map<string, CredentialQuotaCacheEntry>();
const credentialQuotaErrorCache = new Map<string, CredentialQuotaErrorCacheEntry>();

function isCredentialQuotaCacheValid(
  cached: CredentialQuotaCacheEntry | CredentialQuotaErrorCacheEntry | undefined,
  credential: {
    type: CredentialType;
    updatedAt: Date;
  },
): cached is CredentialQuotaCacheEntry | CredentialQuotaErrorCacheEntry {
  if (!cached) return false;
  if (cached.type !== credential.type) return false;
  if (cached.credentialUpdatedAtMs !== credential.updatedAt.getTime()) return false;
  return true;
}

export function getReusableQuotaCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaCacheEntry | null {
  const cached = credentialQuotaCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.sampledAt).getTime() > QUOTA_PROVIDER_REFRESH_MS) return null;
  return cached;
}

export function getFreshQuotaCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaCacheEntry | null {
  const cached = credentialQuotaCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.sampledAt).getTime() > QUOTA_CACHE_MAX_AGE_MS) return null;
  return cached;
}

export function getRecentQuotaErrorCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaErrorCacheEntry | null {
  const cached = credentialQuotaErrorCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.failedAt).getTime() > QUOTA_ERROR_COOLDOWN_MS) return null;
  return cached;
}

export function setQuotaSuccessCache(
  credentialId: string,
  entry: CredentialQuotaCacheEntry,
) {
  credentialQuotaCache.set(credentialId, entry);
  credentialQuotaErrorCache.delete(credentialId);
}

export function setQuotaErrorCache(
  credentialId: string,
  entry: CredentialQuotaErrorCacheEntry,
) {
  credentialQuotaErrorCache.set(credentialId, entry);
}

export function clearCredentialQuotaCacheForTest() {
  credentialQuotaCache.clear();
  credentialQuotaErrorCache.clear();
}
