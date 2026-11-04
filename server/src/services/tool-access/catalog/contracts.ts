import type { ActorInfo } from "../types.js";
import type { FinishToolApp, FinishToolAppResult, ToolCatalogRefreshResult, ToolConnectionHealthCheckResult } from "@paperclipai/shared";

/** Capabilities used by setup and authorization before catalog ownership is constructed. */
export type RefreshConnectionCatalog = (connectionId: string, actor?: ActorInfo, options?: {
  enableAllByDefault?: boolean;
  restoreDraftDefaults?: boolean;
  quarantineManagedOAuthDraft?: boolean;
  skipDefaultProfileSync?: boolean;
  credentialHeaders?: Record<string, string>;
}) => Promise<ToolCatalogRefreshResult>;
export type CheckConnectionHealth = (connectionId: string, actor?: ActorInfo) => Promise<ToolConnectionHealthCheckResult>;
export type FinishConnectionSetup = (companyId: string, connectionId: string, input: FinishToolApp, actor?: ActorInfo) => Promise<FinishToolAppResult>;
