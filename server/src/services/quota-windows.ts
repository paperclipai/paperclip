import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => adapter.getQuotaWindows!()),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    // Determine provider slug from the fulfilled value if available, otherwise fall back
    // to the adapter type so the error is still attributable to the right provider.
    const adapterType = adapters[i]!.type;
    return {
      provider: adapterType,
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}
