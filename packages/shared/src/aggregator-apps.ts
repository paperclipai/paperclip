import { z } from "zod";
import type { ComposioAppSnapshot, ComposioAppSyncState } from "./composio-app-setup.js";
import type { AppCatalogAggregator } from "./aggregator-app-catalog.js";

export const AGGREGATOR_NAMES = { composio: "Composio", arcade: "Arcade", executor: "Executor" } as const;
export function isAppAggregator(value: unknown): value is AppCatalogAggregator {
  return typeof value === "string" && Object.hasOwn(AGGREGATOR_NAMES, value);
}

/** Cached upstream observations. These neither grant access nor create tool connections. */
export interface AggregatorAppSnapshot extends ComposioAppSnapshot {
  provider: AppCatalogAggregator;
  appSlug: string;
  appName: string;
  freshness: "fresh" | "stale";
}
export interface AggregatorAppsResponse {
  provider: AppCatalogAggregator;
  apps: AggregatorAppSnapshot[];
  discovery: {
    availability: "available" | "setup_required" | "unsupported" | "disabled";
    message: string | null;
  };
  sync: Omit<ComposioAppSyncState, "coverage"> & {
    coverage: "supported_catalog" | "gateway_tools" | "visible_accounts";
  };
}
export const aggregatorAppsSyncSchema = z.object({ force: z.boolean().default(false) }).strict();
export const aggregatorAppsRefreshSchema = z.object({
  toolkits: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
export const arcadeDiscoverySetupSchema = z.object({
  apiKey: z.string().trim().min(1).max(8192),
  userId: z.string().trim().min(1).max(500),
}).strict();
export type ArcadeDiscoverySetupInput = z.infer<typeof arcadeDiscoverySetupSchema>;

/** Only trustworthy browser destinations; never expose URL credentials or active schemes. */
export function aggregatorManagementUrl(provider: AppCatalogAggregator, configured?: string | null): string | null {
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|api.?key|authorization|code/i.test(key))) return null;
      if (provider === "composio" && url.hostname !== "dashboard.composio.dev") return null;
      if (provider === "arcade" && url.hostname !== "app.arcade.dev") return null;
      return url.toString();
    } catch { return null; }
  }
  return provider === "composio" ? "https://dashboard.composio.dev/~/org/connect/apps"
    : provider === "arcade" ? "https://app.arcade.dev/" : null;
}
