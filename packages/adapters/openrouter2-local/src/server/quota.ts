import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  return {
    provider: "openrouter",
    source: "openrouter2",
    ok: true,
    windows: [],
  };
}
