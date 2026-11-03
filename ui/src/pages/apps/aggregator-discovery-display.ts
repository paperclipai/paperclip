import { t } from "@/i18n";
import { AGGREGATOR_NAMES, isAppAggregator } from "@paperclipai/shared/aggregator-apps";

// Only the server's exact built-in discovery notices are presentation copy.
// Provider errors and custom messages remain unchanged.
export function aggregatorDiscoveryDisplayText(provider: unknown, source: string | null | undefined): string | null | undefined {
  if (!source || !isAppAggregator(provider)) return source;
  if (source === "Restore this gateway to check its accounts.") return t("oct6Beta.discoveryRestore");
  if (provider === "arcade" && source === "Set up account sync to see your Arcade apps here.") return t("oct6Beta.discoveryArcadeSetup");
  if (provider === "executor" && source === "Executor account discovery is unavailable on this server. You can still use the gateway’s actions.") return t("oct6Beta.discoveryExecutorUnavailable");
  if ((provider === "executor" || provider === "composio") && source === `${AGGREGATOR_NAMES[provider]} account discovery is unavailable on this gateway. Refresh its actions or check its setup.`) {
    return t("oct6Beta.discoveryUnavailable", { provider: AGGREGATOR_NAMES[provider] });
  }
  return source;
}
