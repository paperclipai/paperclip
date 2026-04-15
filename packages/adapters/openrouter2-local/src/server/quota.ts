import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  return {
    provider: "openrouter",
    source: "openrouter",
    ok: true,
    windows: [],
  };
}
