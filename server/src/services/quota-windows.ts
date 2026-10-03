import type { ProviderQuotaResult } from "@paperclipai/shared";
import { redactDiagnosticText } from "@paperclipai/adapter-utils";
import { listServerAdapters } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import { createHash } from "node:crypto";
import { eq, inArray, and } from "drizzle-orm";
import { companySecrets, companySecretVersions, userSecretDefinitions, type Db } from "@paperclipai/db";
import { fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import { aiConnectionService } from "./ai-connections.js";

const accountRequests = new Map<string, { expires: number; result: Promise<ProviderQuotaResult> }>();
const publicError = "Subscription quota is currently unavailable. Check usage with your provider.";

/** Managed connections use their own credentials regardless of where agents run.
 * Never silently substitute the control-plane host's login for a remote account. */
export async function fetchCompanyQuotaWindows(db: Db, companyId: string, userId: string): Promise<ProviderQuotaResult[]> {
  const service = aiConnectionService(db);
  const accounts = await service.quotaAccounts(companyId, userId);
  if (!accounts.length) {
    return ["anthropic", "openai"].map(provider => ({ provider, ok: false,
      accountKey: `unconnected:${companyId}:${provider}`, source: "managed-connection",
      errorFamily: "credentials_unavailable", error: "Connect a subscription account in AI connections to view its quota.", windows: [] }));
  }
  // Resolve revision metadata before consulting the cache, so rotation and
  // revocation cannot serve windows associated with an old credential.
  const secretIds = accounts.flatMap(row => row.grant.credentialSecretRefs.map(ref => ref.secretId));
  const revisions = secretIds.length ? await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion, status: companySecrets.status, versionStatus: companySecretVersions.status, revokedAt: companySecretVersions.revokedAt, definitionId: companySecrets.userSecretDefinitionId, definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt })
    .from(companySecrets).leftJoin(companySecretVersions, and(eq(companySecretVersions.secretId, companySecrets.id), eq(companySecretVersions.version, companySecrets.latestVersion))).leftJoin(userSecretDefinitions, and(eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId), eq(userSecretDefinitions.companyId, companyId))).where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, secretIds))) : [];
  async function readAccount(row: (typeof accounts)[number]): Promise<ProviderQuotaResult> {
    const accountKey = createHash("sha256").update(JSON.stringify([companyId, row.connection.id, row.grant.id,
      row.connection.updatedAt, row.grant.updatedAt,
      row.grant.credentialSecretRefs.map(ref => [ref.secretId, revisions.find(r => r.id === ref.secretId)]),
    ])).digest("hex");
    const base = { provider: row.summary.provider, accountKey, accountLabel: row.summary.name, source: "managed-connection" };
    const definitionUnavailable = row.grant.credentialSecretRefs.some(ref => {
      const revision = revisions.find(value => value.id === ref.secretId);
      return revision?.definitionId && (revision.definitionStatus !== "active" || revision.definitionDeletedAt !== null);
    });
    if (row.summary.status !== "connected" || definitionUnavailable) {
      return { ...base, ok: false, errorFamily: "credentials_unavailable", error: publicError, windows: [] };
    }
    const key = `${userId}:${accountKey}`;
    let pending = accountRequests.get(key);
    if (!pending || pending.expires <= Date.now()) {
      const controller = new AbortController();
      const result = (async (): Promise<ProviderQuotaResult> => {
        let credentialResolved = false;
        try {
          const value = await service.credential(row);
          controller.signal.throwIfAborted();
          credentialResolved = true;
          let windows;
          if (base.provider === "openai") {
            const auth = JSON.parse(value);
            const token = auth.tokens?.access_token ?? auth.accessToken;
            const accountId = auth.tokens?.account_id ?? auth.accountId;
            if (typeof token !== "string" || !token || typeof accountId !== "string" || !accountId) {
              return { ...base, ok: false, errorFamily: "credentials_unavailable", error: publicError, windows: [] };
            }
            windows = await fetchCodexQuota(token, accountId, controller.signal);
          } else {
            windows = await fetchClaudeQuota(value, controller.signal);
          }
          return { ...base, ok: true, windows, capturedAt: new Date().toISOString() };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Quota unavailable";
          const invalid = !credentialResolved || /401|403|refresh_token_(?:reused|expired|invalidated)/i.test(message);
          logger.warn({ companyId, accountKey, provider: base.provider, authenticationFailed: invalid }, "Connected account quota unavailable");
          return { ...base, ok: false, windows: [], error: publicError,
            ...(invalid ? { errorFamily: "authentication_required" } : {}) };
        }
      })();
      const bounded = withQuotaTimeout(base.provider, result, () => controller.abort()).then(quota => ({ ...base, ...quota, ...(quota.ok ? {} : { error: publicError }) }));
      pending = { result: bounded, expires: Date.now() + 30_000 };
      if (accountRequests.size >= 500) accountRequests.delete(accountRequests.keys().next().value!);
      accountRequests.set(key, pending);
    }
    return pending.result;
  }
  const results: ProviderQuotaResult[] = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) {
      const index = next++;
      results[index] = await readAccount(accounts[index]);
    }
  }));
  return results;
}

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, Promise.resolve().then(() => adapter.getQuotaWindows!()))),
  );

  return settled.map((result, i) => {
    const adapterType = adapters[i]!.type;
    const quota: ProviderQuotaResult = result.status === "fulfilled" ? result.value : {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
    if (quota.ok) return { ...quota, error: undefined };
    logger.warn({
      adapterType,
      errorFamily: quota.errorFamily,
      diagnostic: redactDiagnosticText(quota.error ?? "Quota probe failed").slice(0, 2_000),
    }, "Provider subscription quota unavailable");
    return { ...quota, error: "Subscription quota is currently unavailable. Check usage with your provider." };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
  onTimeout?: () => void,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          onTimeout?.();
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
