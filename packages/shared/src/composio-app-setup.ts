import { z } from "zod";

export const composioAppSetupSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
]);
export type ComposioAppSetupInput = z.infer<typeof composioAppSetupSchema>;
export interface ComposioAppSetupResult {
  status: "not_connected" | "authorization_required" | "connected";
  authorizationUrl?: string;
}

export interface ComposioAppAccount {
  id: string;
  alias: string | null;
  status: string;
  isDefault: boolean;
  /** Non-secret metadata for other aggregator inventories; absent in legacy Composio rows. */
  appSlug?: string;
  appName?: string;
  managementUrl?: string | null;
  healthCheckedAt?: string | null;
}

/** Provider observations only; this never grants agent access. */
export interface ComposioAppSnapshot {
  connectionId: string;
  toolkit: string;
  status: "connected" | "not_connected";
  accounts: ComposioAppAccount[];
  checkedAt: string;
  errorAt?: string | null;
}

export interface ComposioAppSyncState {
  status: "idle" | "syncing" | "ready" | "error";
  /** Connect OAuth currently supports checks of catalog toolkits, not list-all enumeration. */
  coverage: "supported_catalog";
  checked: number;
  total: number;
  failed: number;
  lastCompletedAt: string | null;
  error: string | null;
}

export interface ComposioAppsResponse {
  apps: ComposioAppSnapshot[];
  sync: ComposioAppSyncState;
}

export const composioAppsSyncSchema = z.object({ force: z.boolean().default(false) }).strict();

export const composioAppsRefreshSchema = z.object({
  toolkits: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();

const accountId = z.string().min(1).max(200);
export const composioAppAccountSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add") }).strict(),
  z.object({ action: z.literal("rename"), accountId, alias: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("remove"), accountId }).strict(),
]);
export type ComposioAppAccountInput = z.infer<typeof composioAppAccountSchema>;
