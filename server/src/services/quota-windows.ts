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
  const readRevisions = async (ids: string[]) => ids.length ? await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion, status: companySecrets.status, versionStatus: companySecretVersions.status, revokedAt: companySecretVersions.revokedAt, definitionId: companySecrets.userSecretDefinitionId, definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt })
    .from(companySecrets).leftJoin(companySecretVersions, and(eq(companySecretVersions.secretId, companySecrets.id), eq(companySecretVersions.version, companySecrets.latestVersion))).leftJoin(userSecretDefinitions, and(eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId), eq(userSecretDefinitions.companyId, companyId))).where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, ids))) : [];
  const revisions = await readRevisions(secretIds);
  const identity = (row: (typeof accounts)[number], metadata: typeof revisions) => ({
    provider: row.summary.provider,
    accountKey: createHash("sha256").update(JSON.stringify([companyId, row.connection.id, row.grant.id,
      row.connection.updatedAt, row.grant.updatedAt,
      row.grant.credentialSecretRefs.map(ref => [ref.secretId, metadata.find(r => r.id === ref.secretId)]),
    ])).digest("hex"),
    accountLabel: row.summary.name, source: "managed-connection",
  });
  async function readAccount(row: (typeof accounts)[number]): Promise<ProviderQuotaResult> {
    let base = identity(row, revisions);
    const { accountKey } = base;
    const definitionUnavailable = row.grant.credentialSecretRefs.some(ref => {
      const revision = revisions.find(value => value.id === ref.secretId);
      return revision && (revision.status !== "active" || revision.versionStatus === "disabled" || revision.revokedAt != null
        || (revision.definitionId && (revision.definitionStatus !== "active" || revision.definitionDeletedAt !== null)));
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
            let auth;
            try { auth = JSON.parse(value); } catch { throw new Error("credentials_unavailable"); }
            const token = auth.tokens?.access_token ?? auth.accessToken;
            if (typeof token !== "string" || !token) {
              return { ...base, ok: false, errorFamily: "credentials_unavailable", error: publicError, windows: [] };
            }
            const read = (auth: { tokens?: { access_token?: string; account_id?: string | null }; accessToken?: string; accountId?: string | null }) =>
              fetchCodexQuota(auth.tokens?.access_token ?? auth.accessToken!, auth.tokens?.account_id ?? auth.accountId ?? null, controller.signal);
            try { windows = await read(auth); }
            catch (error) {
              if (!(error instanceof Error) || !/\b401\b/.test(error.message)) throw error;
              auth = JSON.parse(await service.refreshQuotaCredential(row, value, controller.signal));
              // Rotation changes both the grant and secret revision. Return and
              // cache the observation under the identity the next poll will see.
              const refreshed = (await service.quotaAccounts(companyId, userId)).find(candidate =>
                candidate.connection.id === row.connection.id && candidate.grant.id === row.grant.id);
              if (!refreshed || refreshed.summary.status !== "connected") throw new Error("credentials_unavailable");
              base = identity(refreshed, await readRevisions(refreshed.grant.credentialSecretRefs.map(ref => ref.secretId)));
              // A reconnect can race the completed refresh. Bind the value and
              // cache identity to one revision, rather than label old quota with
              // a newer account's key. A concurrent change defers this poll.
              const refreshedValue = await service.credential(refreshed);
              const verified = (await service.quotaAccounts(companyId, userId)).find(candidate =>
                candidate.connection.id === row.connection.id && candidate.grant.id === row.grant.id);
              if (!verified || verified.summary.status !== "connected") throw new Error("credentials_unavailable");
              const verifiedIdentity = identity(verified, await readRevisions(verified.grant.credentialSecretRefs.map(ref => ref.secretId)));
              if (verifiedIdentity.accountKey !== base.accountKey) throw new Error("provider_unavailable");
              auth = JSON.parse(refreshedValue);
              controller.signal.throwIfAborted();
              windows = await read(auth);
            }
          } else {
            windows = await fetchClaudeQuota(value, controller.signal);
          }
          return { ...base, ok: true, windows, capturedAt: new Date().toISOString() };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Quota unavailable";
          const missing = message === "credentials_unavailable";
          const invalid = message === "authentication_required" || (credentialResolved && /\b401\b|refresh_token_(?:reused|expired|invalidated)/i.test(message));
          const errorFamily = missing ? "credentials_unavailable" : invalid ? "authentication_required"
            : credentialResolved && /\b403\b/.test(message) ? "permission_denied" : "provider_unavailable";
          logger.warn({ companyId, accountKey, provider: base.provider, authenticationFailed: invalid }, "Connected account quota unavailable");
          return { ...base, ok: false, windows: [], error: publicError,
            errorFamily };
        }
      })();
      const bounded: Promise<ProviderQuotaResult> = withQuotaTimeout(base.provider, result, () => controller.abort()).then(quota => {
        const observation = { ...base, ...quota, ...(quota.ok ? {} : { error: publicError }) };
        if (observation.ok && observation.accountKey !== accountKey) {
          if (accountRequests.get(key)?.result === bounded) accountRequests.delete(key);
          if (accountRequests.size >= 500) accountRequests.delete(accountRequests.keys().next().value!);
          accountRequests.set(`${userId}:${observation.accountKey}`, { result: Promise.resolve(observation), expires: Date.now() + 30_000 });
        }
        return observation;
      });
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
