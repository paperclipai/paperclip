import { getQuotaWindowsForAuth } from "@paperclipai/adapter-codex-local/server";
import type { Db } from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";
import { aiConnectionService } from "./ai-connections.js";

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
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

/**
 * Adds the quota of the managed OpenAI subscription accounts the user may use in this company, one result per
 * account (`accountName`), each with its own ok/error. Agents on managed AI connections have no login in the
 * server's own Codex home, so the local probe fails for them: once managed accounts exist, only a working
 * local probe is kept, named "Local Codex login" to tell it apart from them.
 */
export async function fetchCompanyQuotaWindows(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProviderQuotaResult[]> {
  const [local, accounts] = await Promise.all([
    fetchAllQuotaWindows(),
    aiConnectionService(db).subscriptionCredentials(companyId, userId, "openai"),
  ]);
  if (accounts.length === 0) return local;
  const managed = await Promise.all(
    accounts.map(async (account): Promise<ProviderQuotaResult> => ({
      ...(await withQuotaTimeout(
        "codex_local",
        account.value().then(getQuotaWindowsForAuth, (error: unknown) => ({
          provider: "openai",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          windows: [],
        })),
      )),
      accountName: account.name,
    })),
  );
  return [
    ...local.flatMap((r) =>
      r.provider !== "openai" ? [r] : r.ok ? [{ ...r, accountName: "Local Codex login" }] : [],
    ),
    ...managed,
  ];
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
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
