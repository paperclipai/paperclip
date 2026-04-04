import type { AdapterQuotaContext, ProviderQuotaResult } from "@paperclipai/adapter-utils";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

interface FetchQuotaWindowsOptions {
  adapterTypes?: string[];
  contextsByAdapterType?: Record<string, AdapterQuotaContext | undefined>;
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
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(
  options: FetchQuotaWindowsOptions = {},
): Promise<ProviderQuotaResult[]> {
  const requestedTypes = options.adapterTypes ? new Set(options.adapterTypes) : null;
  const adapters = listServerAdapters().filter(
    (adapter) => adapter.getQuotaWindows != null && (!requestedTypes || requestedTypes.has(adapter.type)),
  );

  const settled = await Promise.allSettled(
    adapters.map((adapter) =>
      withQuotaTimeout(
        adapter.type,
        adapter.getQuotaWindows!(options.contextsByAdapterType?.[adapter.type]),
      ),
    ),
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
