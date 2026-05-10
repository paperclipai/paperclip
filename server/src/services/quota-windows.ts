import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { anthropicAccounts } from "@paperclipai/db";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import {
  fetchClaudeQuota,
  readClaudeTokenFromDir,
} from "@paperclipai/adapter-claude-local/server";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;
const QUOTA_CACHE_TTL_MS = 60_000;

export interface AccountQuotaResult {
  accountId: string;
  label: string;
  windows: QuotaWindow[] | null;
  error?: string;
}

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
 * Returns quota windows for every Anthropic account registered for the company.
 * Results within QUOTA_CACHE_TTL_MS are served from DB fields rather than hitting
 * the Anthropic API again.
 */
export async function getQuotaWindowsForAccounts(
  companyId: string,
  db: Db,
): Promise<AccountQuotaResult[]> {
  const accounts = await db
    .select()
    .from(anthropicAccounts)
    .where(eq(anthropicAccounts.companyId, companyId))
    .orderBy(anthropicAccounts.createdAt);

  return Promise.all(
    accounts.map(async (account): Promise<AccountQuotaResult> => {
      if (account.mode === "bedrock" || account.mode === "api_key") {
        return { accountId: account.id, label: account.label, windows: [] };
      }

      // Check cache
      const now = Date.now();
      if (
        account.lastQuotaCheckAt != null &&
        now - account.lastQuotaCheckAt.getTime() < QUOTA_CACHE_TTL_MS
      ) {
        return {
          accountId: account.id,
          label: account.label,
          windows: buildCachedWindows(account.lastUtilizationFiveHour, account.lastUtilizationSevenDay),
          error: account.lastQuotaError ?? undefined,
        };
      }

      // Live fetch
      if (!account.credentialDir) {
        const error = "No credential directory configured for this account";
        await saveQuotaError(db, account.id, error);
        return { accountId: account.id, label: account.label, windows: null, error };
      }

      const token = await readClaudeTokenFromDir(account.credentialDir);
      if (!token) {
        const error = "No OAuth token found; run claude login for this account";
        await saveQuotaError(db, account.id, error);
        return { accountId: account.id, label: account.label, windows: null, error };
      }

      try {
        const windows = await fetchClaudeQuota(token);
        const fiveHour = windows.find((w) => w.label === "Current session")?.usedPercent ?? null;
        const sevenDay = windows.find((w) => w.label === "Current week (all models)")?.usedPercent ?? null;
        await db
          .update(anthropicAccounts)
          .set({
            lastQuotaCheckAt: new Date(),
            lastUtilizationFiveHour: fiveHour != null ? String(fiveHour) : null,
            lastUtilizationSevenDay: sevenDay != null ? String(sevenDay) : null,
            lastQuotaError: null,
            updatedAt: new Date(),
          })
          .where(eq(anthropicAccounts.id, account.id));
        return { accountId: account.id, label: account.label, windows };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await saveQuotaError(db, account.id, error);
        return { accountId: account.id, label: account.label, windows: null, error };
      }
    }),
  );
}

function buildCachedWindows(
  fiveHour: string | null,
  sevenDay: string | null,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (fiveHour != null) {
    windows.push({
      label: "Current session",
      usedPercent: Number(fiveHour),
      resetsAt: null,
      valueLabel: null,
      detail: null,
    });
  }
  if (sevenDay != null) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: Number(sevenDay),
      resetsAt: null,
      valueLabel: null,
      detail: null,
    });
  }
  return windows;
}

async function saveQuotaError(db: Db, accountId: string, error: string): Promise<void> {
  await db
    .update(anthropicAccounts)
    .set({ lastQuotaCheckAt: new Date(), lastQuotaError: error, updatedAt: new Date() })
    .where(eq(anthropicAccounts.id, accountId));
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
