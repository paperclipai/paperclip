import type { Db } from "@paperclipai/db";
import { awaitingHumanBridgeService } from "./awaiting-human-bridge.js";
import { resolveAwaitingHumanBridgeAdapter, hasAwaitingHumanBridgeAdapter } from "./awaiting-human-bridge-registry.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";

export function awaitingHumanBridgeRuntime(db: Db) {
  const awaitingHumanSettings = awaitingHumanSettingsService(db);
  return awaitingHumanBridgeService(db, {
    resolveProviderForCompany: async (companyId) => awaitingHumanSettings.resolveProvider(companyId),
    resolveAdapter: (provider) => resolveAwaitingHumanBridgeAdapter(provider, db),
    hasAdapter: (provider) => hasAwaitingHumanBridgeAdapter(provider),
  });
}
