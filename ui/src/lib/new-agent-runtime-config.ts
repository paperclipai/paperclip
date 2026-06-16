import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  heartbeatEnabled?: boolean;
  intervalSec?: number;
  cheapModel?: string;
  cheapModelEnabled?: boolean;
  cheapRouteEnabled?: boolean;
  cheapRouteAdapterType?: string;
  cheapRouteModel?: string;
  cheapRouteCredentialIds?: string[];
  backupRouteEnabled?: boolean;
  backupRouteAdapterType?: string;
  backupRouteModel?: string;
  backupRouteCredentialIds?: string[];
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    heartbeat: {
      enabled: input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled,
      intervalSec: input?.intervalSec ?? defaultCreateValues.intervalSec,
      wakeOnDemand: true,
      cooldownSec: 10,
      maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    },
  };

  const cheapModel = input?.cheapModel?.trim() ?? "";
  const cheapEnabled = input?.cheapModelEnabled ?? false;
  if (cheapModel && cheapEnabled) {
    config.modelProfiles = {
      cheap: {
        enabled: true,
        adapterConfig: { model: cheapModel },
      },
    };
  }

  const routes: Record<string, unknown> = {};
  if (input?.cheapRouteEnabled) {
    routes.cheap = {
      enabled: true,
      adapterType: input.cheapRouteAdapterType || "codex_local",
      adapterConfig: input.cheapRouteModel?.trim() ? { model: input.cheapRouteModel.trim() } : {},
      credentialIds: input.cheapRouteCredentialIds ?? [],
    };
  }
  if (input?.backupRouteEnabled) {
    routes.backup = {
      enabled: true,
      adapterType: input.backupRouteAdapterType || "codex_local",
      adapterConfig: input.backupRouteModel?.trim() ? { model: input.backupRouteModel.trim() } : {},
      credentialIds: input.backupRouteCredentialIds ?? [],
    };
  }
  if (Object.keys(routes).length > 0) {
    config.routes = routes;
  }

  return config;
}
